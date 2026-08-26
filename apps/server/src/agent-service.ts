import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isModelConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { createTraceContext, type TraceContext } from "./glassbox/context.js";
import {
  createDefaultEmitter,
  type ObservationEmitter,
  type SpanHandle,
} from "./glassbox/emitter.js";
import { newId, type TraceStatus } from "./glassbox/schema.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentConfigSnapshot,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export function configSnapshot(agent: Agent, config: AppConfig): AgentConfigSnapshot {
  return {
    instructions: "sha256:" + createHash("sha256").update(agent.instructions).digest("hex"),
    modelProvider: config.modelProvider,
    model: config.modelProvider === "ark" ? config.arkModel : config.openaiModel || "openai-default",
    codexSandboxMode: config.codexSandboxMode,
    runtimeProvider: config.runtimeProvider,
    containerRuntimeImage: config.containerRuntimeImage,
    capturePolicy: config.glassboxCapturePolicy,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

export function configHash(snapshot: AgentConfigSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex").slice(0, 16);
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly spans = new Map<
    string,
    {
      traceId: string;
      rootSpanId: string;
      agentId: string;
      requestId?: string | undefined;
      service?: SpanHandle | undefined;
      cancelRequestedAt?: string | undefined;
    }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly emitter: ObservationEmitter = createDefaultEmitter(),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const interrupted: AgentRun[] = [];
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          interrupted.push(structuredClone(run));
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    for (const run of interrupted) {
      if (!run.traceId) continue;
      // The server itself cancelled this Run, not the local user: say so in the actor fields.
      this.emitter.emit({
        traceId: run.traceId,
        spanId: newId("spn"),
        runId: run.id,
        agentId: run.agentId,
        actorId: "server",
        actorType: "service",
        type: "run.cancelled",
        category: "control",
        name: "run.cancelled",
        status: "cancelled",
        source: { component: "AgentService", observed: true },
        attributes: { reason: "server_restart" },
      });
    }
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  allRuns(): AgentRun[] {
    return this.store.snapshot().runs;
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    context?: TraceContext,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "No model provider is configured. Set MODEL_PROVIDER and its credentials in .env, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const ctx = context ?? createTraceContext({}, this.emitter.capturePolicy);
    const run: AgentRun = {
      id: runId,
      traceId: ctx.traceId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      run.configSnapshot = configSnapshot(storedAgent, this.config);
      run.configHash = configHash(run.configSnapshot);
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    // Published only once the Run really exists (invariant 3: never fabricate evidence). A rejected
    // request (404/409) must leave `ctx.runId`/`ctx.agentId` unset, or the ingress `onResponse` hook
    // emits an orphan http.request.completed for a Run that never was.
    ctx.runId = runId;
    ctx.agentId = agentId;
    const ids = {
      traceId: ctx.traceId,
      runId,
      agentId,
      requestId: ctx.requestId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
    };
    if (context) {
      this.emitter.emit({
        ...ids,
        spanId: ctx.rootSpanId,
        type: "http.request.received",
        category: "control",
        phase: "start",
        status: "running",
        name: (ctx.method ?? "POST") + " /api/agents/:id/messages",
        timestamp: ctx.receivedAt,
        source: { component: "Fastify", observed: true },
      });
    }
    this.emitter.emit({
      ...ids,
      spanId: newId("spn"),
      ...(context ? { parentSpanId: ctx.rootSpanId } : {}),
      type: "run.created",
      category: "control",
      name: "run.created",
      status: "ok",
      source: { component: "AgentService", observed: true },
      attributes: { promptBytes: Buffer.byteLength(prompt, "utf8"), configHash: run.configHash! },
    });
    this.spans.set(runId, {
      traceId: ctx.traceId,
      rootSpanId: ctx.rootSpanId,
      agentId,
      requestId: ctx.requestId,
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      modelConfigured: isModelConfigured(this.config),
      modelProvider: this.config.modelProvider,
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const link = this.spans.get(run.id);
    const ids = link
      ? {
          traceId: link.traceId,
          runId: run.id,
          agentId: agentAtStart.id,
          requestId: link.requestId,
        }
      : undefined;
    let service: SpanHandle | undefined;
    try {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) {
          storedRun.status = "running";
          storedRun.startedAt = now();
        }
      });
      // Only after the Run really is `running` (invariant 3: never emit a fact that didn't happen yet).
      service =
        ids && link
          ? this.emitter.startSpan({
              ...ids,
              spanId: newId("spn"),
              parentSpanId: link.rootSpanId,
              type: "agent_service.run.started",
              category: "control",
              name: "agent_service.run",
              source: { component: "AgentService", observed: true },
              attributes: { resume: agentAtStart.codexThreadId !== null },
            })
          : undefined;
      if (link) link.service = service;
      if (ids && service) {
        this.emitter.emit({
          ...ids,
          spanId: newId("spn"),
          parentSpanId: service.spanId,
          type: "run.started",
          category: "control",
          name: "run.started",
          status: "ok",
          source: { component: "AgentService", observed: true },
        });
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        ...(ids && service
          ? {
              trace: {
                traceId: ids.traceId,
                runId: run.id,
                agentId: agentAtStart.id,
                parentSpanId: service.spanId,
              },
            }
          : {}),
        ...(this.config.glassboxDemoFailure === "timeout" ? { timeoutMs: 3_000 } : {}),
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      if (ids && service) {
        this.emitter.emit({
          ...ids,
          spanId: newId("spn"),
          parentSpanId: service.spanId,
          type: "run.completed",
          category: "control",
          name: "run.completed",
          status: "ok",
          source: { component: "AgentService", observed: true },
          attributes: {
            outputBytes: Buffer.byteLength(result.output, "utf8"),
            ...(result.usage ?? {}),
          },
          ...(result.threadId ? { sessionId: result.threadId } : {}),
        });
        service.end("ok", { type: "agent_service.run.completed" });
      }
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      if (ids && service) {
        const status: TraceStatus = cancelled
          ? "cancelled"
          : /timed out/i.test(message)
            ? "timeout"
            : "error";
        const type =
          status === "cancelled"
            ? "run.cancelled"
            : status === "timeout"
              ? "run.timed_out"
              : "run.failed";
        this.emitter.emit({
          ...ids,
          spanId: newId("spn"),
          parentSpanId: service.spanId,
          type,
          category: "control",
          name: type,
          status,
          source: { component: "AgentService", observed: true },
          error: { type: status, message },
          attributes: {
            ...(link?.cancelRequestedAt
              ? { cancelRequestedAt: link.cancelRequestedAt, cancelledBy: "local-user" }
              : {}),
          },
        });
        service.end(status, {
          type: "agent_service.run.failed",
          error: { type: status, message },
        });
      }
    } finally {
      this.spans.delete(run.id);
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    for (const link of this.spans.values()) {
      if (link.agentId === agentId) link.cancelRequestedAt = now();
    }
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
