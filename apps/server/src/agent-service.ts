import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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
  EvalRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RegressionCase,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { boundedChangedPaths, diffWorkspace, snapshotWorkspace } from "./workspace-snapshot.js";

const now = () => new Date().toISOString();

type ExecutionOptions = {
  runId?: string;
  workspacePath?: string;
  workspaceName?: string;
  tags?: Record<string, string | number | boolean>;
  persistMessages?: boolean;
  persistThread?: boolean;
  cleanup?: () => Promise<void>;
};

export interface IsolatedRunInput {
  agentId: string;
  workspaceTemplate: string;
  prompt: string;
  tags?: Record<string, string | number | boolean>;
}

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
    /** Fires after a Run's terminal event is emitted (Run end and restart-cancel); wired to the summary rollup (#168). */
    private readonly onRunEnded?: ((runId: string) => void) | undefined,
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
      // EvalRunner progress lives only in the in-process promise, so a running EvalRun cannot resume.
      for (const evalRun of database.evalRuns) {
        if (evalRun.status !== "running") continue;
        evalRun.status = "failed";
        evalRun.completedAt = now();
        evalRun.results.push({ caseId: "", results: [], error: "Server restarted while this Eval Run was active" });
      }
    });
    // AGENTS.md is platform-owned. Refresh every existing workspace at boot so newly introduced
    // safety/runtime guidance reaches Agents created by earlier versions too.
    for (const agent of this.store.snapshot().agents) {
      await this.workspaces.writeInstructions(agent);
    }
    for (const run of interrupted) {
      if (!run.traceId) continue;
      // The server itself cancelled this Run, not the local user: say so in the actor fields.
      this.emitter.emit({
        traceId: run.traceId,
        spanId: newId("spn"),
        ...(run.traceParentSpanId ? { parentSpanId: run.traceParentSpanId } : {}),
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
      this.onRunEnded?.(run.id);
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
    if (input.workspace !== undefined && input.workspace.trim() === "") throw new HttpError(400, "Invalid workspace name");
    const workspaceName = input.workspace?.trim() ?? id;
    let workspacePath: string;
    try { workspacePath = this.workspaces.pathForName(workspaceName); }
    catch { throw new HttpError(400, "Invalid workspace name"); }
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath,
      workspaceName,
      workspaceManaged: input.workspace === undefined,
      ...(input.template ? { workspaceTemplate: input.template } : {}),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try { await this.workspaces.create(agent, input.workspace !== undefined, input.template); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Unable to create workspace"); }
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    let nextWorkspacePath: string | undefined;
    if (input.workspace !== undefined) {
      try { nextWorkspacePath = this.workspaces.pathForName(input.workspace.trim()); }
      catch { throw new HttpError(400, "Invalid workspace name"); }
      if (nextWorkspacePath !== current.workspacePath) await this.workspaces.create({ ...current, workspacePath: nextWorkspacePath }, true);
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
      if (input.workspace !== undefined && nextWorkspacePath !== undefined && nextWorkspacePath !== agent.workspacePath) {
        agent.workspacePath = nextWorkspacePath;
        agent.workspaceName = input.workspace.trim();
        agent.workspaceManaged = false;
        agent.codexThreadId = null;
      }
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
    const others = this.store.snapshot().agents.filter((item) => item.id !== id && path.resolve(item.workspacePath) === path.resolve(agent.workspacePath));
    const managed = agent.workspaceManaged ?? path.basename(agent.workspacePath) === agent.id;
    const archivedWorkspace = managed && others.length === 0 ? await this.workspaces.archive(agent) : "";
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async listWorkspaces() {
    return this.workspaces.list(this.store.snapshot().agents);
  }

  async listWorkspaceTemplates() {
    return this.workspaces.listTemplates();
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

  listRegressionCases(): RegressionCase[] {
    return this.store.snapshot().regressionCases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRegressionCase(id: string): RegressionCase {
    const item = this.store.snapshot().regressionCases.find((candidate) => candidate.id === id);
    if (!item) throw new HttpError(404, "Regression case not found");
    return item;
  }

  /** A missing or oversized template is a client error (400), not a server fault, wherever a case names one. */
  private async templateHash(name: string): Promise<string> {
    try { return await this.workspaces.templateHash(name); }
    catch (error) {
      // a missing directory is the caller's mistake; never echo the server's filesystem path back
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(400, `Workspace template not found: ${name}`);
      throw new HttpError(400, error instanceof Error ? error.message : "Unable to hash workspace template");
    }
  }

  async createRegressionCase(input: Omit<RegressionCase, "id" | "createdAt" | "templateHash">): Promise<RegressionCase> {
    const item: RegressionCase = { ...input, templateHash: await this.templateHash(input.workspaceTemplate), id: randomUUID(), createdAt: now() };
    await this.store.mutate((database) => database.regressionCases.push(item));
    return item;
  }

  async deleteRegressionCase(id: string): Promise<void> {
    await this.store.mutate((database) => {
      if (!database.regressionCases.some((item) => item.id === id)) throw new HttpError(404, "Regression case not found");
      database.regressionCases = database.regressionCases.filter((item) => item.id !== id);
    });
  }

  listEvalRuns(): EvalRun[] { return this.store.snapshot().evalRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getEvalRun(id: string): EvalRun {
    const item = this.store.snapshot().evalRuns.find((candidate) => candidate.id === id);
    if (!item) throw new HttpError(404, "Eval Run not found");
    return item;
  }
  /** Recomputes each case's template hash; a template edited since the case was recorded is refused unless `force`. */
  async createEvalRun(input: Omit<EvalRun, "id" | "createdAt" | "runIds" | "results" | "status" | "templateHashes" | "templateHashMismatch">, options: { force?: boolean | undefined } = {}): Promise<EvalRun> {
    const templateHashes: Record<string, string> = {};
    let mismatch = false;
    for (const regressionCase of input.caseIds.map((id) => this.getRegressionCase(id))) {
      const current = (templateHashes[regressionCase.workspaceTemplate] ??= await this.templateHash(regressionCase.workspaceTemplate));
      if (regressionCase.templateHash !== undefined && regressionCase.templateHash !== current) mismatch = true;
    }
    if (mismatch && !options.force) throw new HttpError(409, "template changed since the case was recorded");
    const item: EvalRun = { ...input, templateHashes, ...(mismatch ? { templateHashMismatch: true } : {}), id: randomUUID(), runIds: [], results: [], status: "running", createdAt: now() };
    await this.store.mutate((database) => database.evalRuns.push(item));
    return item;
  }
  async updateEvalRun(id: string, update: (item: EvalRun) => void): Promise<void> {
    await this.store.mutate((database) => { const item = database.evalRuns.find((candidate) => candidate.id === id); if (!item) throw new HttpError(404, "Eval Run not found"); update(item); });
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    context?: TraceContext,
    options: ExecutionOptions = {},
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "No model provider is configured. Set MODEL_PROVIDER and its credentials in .env, then restart.",
      );
    }
    const timestamp = now();
    const runId = options.runId ?? randomUUID();
    const ctx = context ?? createTraceContext({}, this.emitter.capturePolicy);
    const run: AgentRun = {
      id: runId,
      traceId: ctx.traceId,
      traceParentSpanId: ctx.rootSpanId,
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
      const workspaceBusy = database.agents.some((candidate) =>
        candidate.id !== storedAgent.id && candidate.status === "busy" && path.resolve(candidate.workspacePath) === path.resolve(storedAgent.workspacePath));
      if (workspaceBusy) throw new HttpError(409, "Workspace is busy");
      run.configSnapshot = configSnapshot(storedAgent, this.config);
      run.configHash = configHash(run.configSnapshot);
      database.runs.push(run);
      if (options.persistMessages !== false) database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return options.workspacePath
        ? { ...snapshot, workspacePath: options.workspacePath, ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}), codexThreadId: options.persistThread === false ? null : snapshot.codexThreadId }
        : snapshot;
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
      attributes: { promptBytes: Buffer.byteLength(prompt, "utf8"), configHash: run.configHash!, workspace: agentAtStart.workspaceName ?? path.basename(agentAtStart.workspacePath), ...options.tags },
    });
    this.spans.set(runId, {
      traceId: ctx.traceId,
      rootSpanId: ctx.rootSpanId,
      agentId,
      requestId: ctx.requestId,
    });
    const execution = this.executeRun(agentAtStart, run, options);
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

  /**
   * Resolve once the Run reaches a terminal status. Awaits the tracked execution when this process owns
   * it; otherwise (a Run started before a restart) polls the store, bounded by the runner timeout plus grace.
   */
  async waitForRun(runId: string): Promise<AgentRun> {
    const deadline = Date.now() + this.config.codexTimeoutMs + 30_000;
    while (Date.now() < deadline) {
      const run = this.getRun(runId);
      if (run.status !== "queued" && run.status !== "running") return run;
      const execution = this.activeExecutions.get(run.agentId);
      if (execution) await execution.catch(() => undefined);
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Run " + runId + " did not finish within " + (this.config.codexTimeoutMs + 30_000) + " ms");
  }

  /**
   * Run a prompt from a new template copy and a fresh runner thread. It deliberately does not add
   * conversation messages or a thread id to the target Agent, while retaining the ordinary Run/trace.
   */
  async runIsolated(input: IsolatedRunInput): Promise<{ run: AgentRun; message: Message }> {
    const runId = randomUUID();
    const agent = this.getAgent(input.agentId);
    let materialized = false;
    try {
      const templateHash = await this.workspaces.templateHash(input.workspaceTemplate);
      const workspacePath = await this.workspaces.materializeEvalWorkspace(runId, input.workspaceTemplate, agent);
      materialized = true;
      return await this.sendMessage(input.agentId, input.prompt, undefined, {
        runId,
        workspacePath,
        workspaceName: input.workspaceTemplate,
        tags: { ...input.tags, templateHash },
        persistMessages: false,
        persistThread: false,
        ...(this.config.keepEvalWorkspaces ? {} : { cleanup: () => this.workspaces.removeEvalWorkspace(runId) }),
      });
    } catch (error) {
      if (materialized) await this.workspaces.removeEvalWorkspace(runId);
      throw error;
    }
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
      glassboxStore: this.config.glassboxStore,
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

  private async executeRun(agentAtStart: Agent, run: AgentRun, options: ExecutionOptions = {}): Promise<void> {
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
      if (service) {
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (storedRun) storedRun.traceParentSpanId = service!.spanId;
        });
      }
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
      const workspaceBefore = await snapshotWorkspace(agentAtStart.workspacePath).catch(() => undefined);
      // Last look before handing off to the runner: a stop that arrived during the snapshot must still win.
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      await this.workspaces.writeInstructions(agentAtStart);
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
      if (workspaceBefore && ids && service) {
        const workspaceAfter = await snapshotWorkspace(agentAtStart.workspacePath).catch(() => undefined);
        if (workspaceAfter) {
          const changes = diffWorkspace(workspaceBefore, workspaceAfter);
          this.emitter.emit({
            ...ids,
            spanId: newId("spn"),
            parentSpanId: service.spanId,
            type: "workspace.changed",
            category: "workspace",
            name: "workspace.changed",
            status: "ok",
            source: { component: "AgentService", adapter: "WorkspaceSnapshot", observed: true },
            attributes: {
              added: changes.added.length,
              modified: changes.modified.length,
              removed: changes.removed.length,
              bytesDelta: changes.bytesDelta,
              truncated: changes.truncated,
              paths: boundedChangedPaths(changes),
            },
          });
        }
      }
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        if (options.persistMessages !== false) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: result.output,
            createdAt: completedAt,
          });
        }
        agent.status = "ready";
        if (options.persistThread !== false) agent.codexThreadId = result.threadId;
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
      this.onRunEnded?.(run.id);
      await options.cleanup?.();
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
