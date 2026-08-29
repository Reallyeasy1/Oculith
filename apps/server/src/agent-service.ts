import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { configuredModel, isModelConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { createTraceContext, type TraceContext } from "./glassbox/context.js";
import { describeFinalMessage } from "./glassbox/codex-observer.js";
import {
  createDefaultEmitter,
  type ObservationEmitter,
  type SpanHandle,
} from "./glassbox/emitter.js";
import { redactText } from "./glassbox/redact.js";
import { capturesSummaries, newId, type TraceStatus } from "./glassbox/schema.js";
import { PostCheckRunner } from "./postcheck-runner.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentConfigSnapshot,
  AgentRun,
  Database,
  EvalRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  QueuedMessageReceipt,
  RegressionCase,
  RunActivity,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { LOG_SECRET_ASSIGNMENT, type RunLogStore } from "./run-log-store.js";
import { boundedChangedPaths, diffWorkspace, snapshotWorkspace } from "./workspace-snapshot.js";

const now = () => new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Max messages a busy Agent will queue (#254); beyond it the POST is refused with 429. */
export const PENDING_MESSAGES_CAP = 10;
// ponytail: fixed 30s — the eval post_check default; make it per-Agent when someone needs more.
const VERIFY_TIMEOUT_MS = 30_000;
/** Set on a RunSummary whose taskOutcome came from the Agent's verifyCommand (#253). */
export const VERIFY_OUTCOME_SOURCE = "post_check";
/** taskOutcome verdict handed to the rollup after a completed ordinary Run (#253). */
export interface VerifyOutcome { taskOutcome: "passed" | "failed"; source: string }
export const serverHeartbeatPath = (dataDirectory: string) => path.join(dataDirectory, "server-heartbeat.json");

interface AppLogger {
  child(bindings: Record<string, unknown>): { info(message: string): void; warn?(message: string): void; error(error: unknown, message?: string): void };
}

type ExecutionOptions = {
  runId?: string;
  workspacePath?: string;
  workspaceName?: string;
  tags?: Record<string, string | number | boolean>;
  persistMessages?: boolean;
  persistThread?: boolean;
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
    model: configuredModel(config),
    codexSandboxMode: config.codexSandboxMode,
    runtimeProvider: config.runtimeProvider,
    containerRuntimeImage: config.containerRuntimeImage,
    containerCpuLimit: config.containerCpuLimit,
    containerMemoryLimit: config.containerMemoryLimit,
    containerPidsLimit: config.containerPidsLimit,
    capturePolicy: config.glassboxCapturePolicy,
    // Hashed like instructions: the command text may carry operator secrets and the snapshot is shown in the UI.
    ...(agent.verifyCommand
      ? { verifyCommand: "sha256:" + createHash("sha256").update(agent.verifyCommand).digest("hex") }
      : {}),
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
  private heartbeatTimer: NodeJS.Timeout | undefined;
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
  private appLogger?: AppLogger | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly emitter: ObservationEmitter = createDefaultEmitter(),
    /** Fires after a Run's terminal event is emitted (Run end and restart-cancel); wired to the summary rollup (#168).
     * `verify` carries the verifyCommand verdict of a completed ordinary Run (#253) for the rollup to stamp. */
    private readonly onRunEnded?: ((runId: string, verify?: VerifyOutcome) => void) | undefined,
    private readonly runLogs?: RunLogStore | undefined,
  ) {}

  setLogger(logger: AppLogger): void { this.appLogger = logger; }

  async initialize(): Promise<void> {
    const lastSeenAt = await this.readHeartbeat();
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
          run.currentActivity = undefined;
        }
      }
      for (const agent of database.agents) {
        // `error` is legacy (pre-#266): failed Runs now leave `ready` with lastError kept; migrate
        // stored Agents so the API never serves the status again (lastError is preserved for display).
        if (agent.status === "busy" || agent.status === "error") {
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
        attributes: { reason: "server_restart", ...(lastSeenAt ? { lastSeenAt } : {}) },
      });
      this.onRunEnded?.(run.id);
    }
    // #254: messages queued before the restart are kept. The interrupted Run was cancelled above and
    // nothing else would ever trigger a dequeue, so resume each Agent's queue now, noting the
    // interruption on the first dequeued Run's log.
    for (const agent of this.store.snapshot().agents) {
      if (agent.status === "ready" && agent.pendingMessages?.length) {
        await this.dequeueAndStart(agent.id, "Server restarted while messages were queued for this Agent; resuming the queue");
      }
    }
  }

  private async readHeartbeat(): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(serverHeartbeatPath(this.config.dataDirectory), "utf8")) as { lastSeenAt?: unknown };
      if (typeof value.lastSeenAt !== "string" || Number.isNaN(Date.parse(value.lastSeenAt))) return undefined;
      return new Date(value.lastSeenAt).toISOString();
    } catch {
      return undefined;
    }
  }

  private async writeHeartbeat(): Promise<void> {
    const target = serverHeartbeatPath(this.config.dataDirectory);
    const temporary = target + ".tmp";
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify({ lastSeenAt: now() }) + "\n", "utf8");
    await rename(temporary, target);
  }

  async startHeartbeat(): Promise<void> {
    this.stopHeartbeat();
    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.writeHeartbeat().catch(() => undefined), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
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
      ...(input.verifyCommand?.trim() ? { verifyCommand: input.verifyCommand.trim() } : {}),
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
      if (input.verifyCommand !== undefined) {
        const command = input.verifyCommand.trim();
        if (command) agent.verifyCommand = command;
        else delete agent.verifyCommand;
      }
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
    await this.setStatus(id, "ready");
    // #254: a stop keeps the queue without starting it; starting the Agent resumes it.
    await this.dequeueAndStart(id);
    return this.getAgent(id);
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
  ): Promise<{ run: AgentRun; message: Message } | QueuedMessageReceipt> {
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
    const outcome = await this.store.mutate((database): { agent: Agent } | { receipt: QueuedMessageReceipt } => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        // #254: a busy Agent queues plain messages instead of failing. Isolated/eval Runs
        // (the only callers passing runId/workspacePath) carry options a dequeue could not
        // reproduce, so they keep the 409.
        if (options.runId !== undefined || options.workspacePath !== undefined) {
          throw new HttpError(409, "This Agent is already running");
        }
        const pending = (storedAgent.pendingMessages ??= []);
        if (pending.length >= PENDING_MESSAGES_CAP) {
          throw new HttpError(429, "This Agent's message queue is full (" + PENDING_MESSAGES_CAP + " pending)");
        }
        pending.push({ id: message.id, content: prompt, queuedAt: timestamp });
        storedAgent.updatedAt = timestamp;
        return { receipt: { queued: true, position: pending.length, messageId: message.id } };
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
      return {
        agent: options.workspacePath
          ? { ...snapshot, workspacePath: options.workspacePath, ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}), codexThreadId: options.persistThread === false ? null : snapshot.codexThreadId }
          : snapshot,
      };
    });
    // A queued message has no Run yet: like the rejected path below, ctx stays unset so the ingress
    // hook emits nothing — the dequeued Run opens its own trace later (invariant 3).
    if ("receipt" in outcome) return outcome.receipt;
    const agentAtStart = outcome.agent;
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
      attributes: {
        promptBytes: Buffer.byteLength(prompt, "utf8"),
        configHash: run.configHash!,
        workspace: agentAtStart.workspaceName ?? path.basename(agentAtStart.workspacePath),
        ...options.tags,
        promptHash: createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16),
      },
      // #258: bounded prompt summary, opt-in only — same gate as the run.completed outcome summary.
      // The emitter's redactEvent scans it and would also strip it at metadata_only (policy_drop_summary).
      ...(capturesSummaries(this.emitter.capturePolicy)
        ? { summary: { text: redactText(prompt).text.slice(0, 240), policy: "safe_summary" as const } }
        : {}),
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
  async runIsolated(input: IsolatedRunInput): Promise<{ run: AgentRun; message: Message; workspacePath: string; cleanup: () => Promise<void> }> {
    const runId = randomUUID();
    const agent = this.getAgent(input.agentId);
    let materialized = false;
    try {
      const templateHash = await this.workspaces.templateHash(input.workspaceTemplate);
      const workspacePath = await this.workspaces.materializeEvalWorkspace(runId, input.workspaceTemplate, agent);
      materialized = true;
      const result = await this.sendMessage(input.agentId, input.prompt, undefined, {
        runId,
        workspacePath,
        workspaceName: input.workspaceTemplate,
        tags: { ...input.tags, templateHash },
        persistMessages: false,
        persistThread: false,
      });
      // Isolated Runs pass runId/workspacePath, which sendMessage never queues (#254).
      if ("queued" in result) throw new HttpError(409, "This Agent is already running");
      // #282 ordering: the workspace must outlive the Run — post_check assertions execute in it after
      // the Run finishes, so removal is the caller's job (EvalRunner cleans up after evaluateAll), not
      // executeRun's. KEEP_EVAL_WORKSPACES=1 keeps the workspace forever by making cleanup a no-op.
      return {
        ...result,
        workspacePath,
        cleanup: this.config.keepEvalWorkspaces ? async () => undefined : () => this.workspaces.removeEvalWorkspace(runId),
      };
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
      // #260: the label must match runtimeProvider — local-process is a child process,
      // container is the per-run application container (engine named when known).
      runtime:
        this.config.runtimeProvider === "container"
          ? `Codex CLI in ${this.config.containerEngine} container`
          : "Codex CLI as local process",
    };
  }

  /** Removes one still-pending message from the Agent's queue (#254); a message already dequeued into a Run is a 404. */
  async cancelPendingMessage(agentId: string, messageId: string): Promise<void> {
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      const index = (agent.pendingMessages ?? []).findIndex((item) => item.id === messageId);
      if (index < 0) throw new HttpError(404, "Pending message not found");
      agent.pendingMessages!.splice(index, 1);
      agent.updatedAt = now();
    });
  }

  /**
   * #254: shifts the Agent's next pending message into a queued Run + user Message and re-claims the
   * Agent. MUST run inside the store mutation that frees the Agent — that is where the one-active-Run
   * invariant lives, so freeing and re-claiming are one atomic transaction.
   */
  private dequeueNext(
    database: Database,
    agent: Agent,
    ctx: TraceContext,
  ): { run: AgentRun; agentAtStart: Agent; ctx: TraceContext; queuedMs: number } | undefined {
    const next = agent.pendingMessages?.shift();
    if (!next) return undefined;
    const timestamp = now();
    const run: AgentRun = {
      id: randomUUID(),
      traceId: ctx.traceId,
      traceParentSpanId: ctx.rootSpanId,
      agentId: agent.id,
      status: "queued",
      prompt: next.content,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    run.configSnapshot = configSnapshot(agent, this.config);
    run.configHash = configHash(run.configSnapshot);
    database.runs.push(run);
    // The chat Message keeps the pending id and queuedAt: it is the same user utterance, sent then.
    database.messages.push({ id: next.id, agentId: agent.id, runId: run.id, role: "user", content: next.content, createdAt: next.queuedAt });
    agent.status = "busy";
    agent.lastError = null;
    agent.updatedAt = timestamp;
    return {
      run: structuredClone(run),
      agentAtStart: structuredClone(agent),
      ctx,
      queuedMs: Math.max(0, Date.parse(timestamp) - Date.parse(next.queuedAt)),
    };
  }

  /** Emits the dequeued Run's own `run.created` (with `queuedMs`) on its fresh trace and starts execution. */
  private startDequeuedRun(
    dequeued: { run: AgentRun; agentAtStart: Agent; ctx: TraceContext; queuedMs: number },
    restartNote?: string,
  ): void {
    const { run, agentAtStart, ctx, queuedMs } = dequeued;
    if (restartNote) {
      // #232 log seam: one line on the new Run's log telling the operator the wait crossed a restart.
      void this.runLogs
        ?.child({ runId: run.id, traceId: ctx.traceId, agentId: agentAtStart.id, component: "AgentService" })
        .info(restartNote)
        .catch(() => undefined);
    }
    this.emitter.emit({
      traceId: ctx.traceId,
      spanId: newId("spn"),
      runId: run.id,
      agentId: agentAtStart.id,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      type: "run.created",
      category: "control",
      name: "run.created",
      status: "ok",
      source: { component: "AgentService", observed: true },
      attributes: {
        promptBytes: Buffer.byteLength(run.prompt, "utf8"),
        configHash: run.configHash!,
        workspace: agentAtStart.workspaceName ?? path.basename(agentAtStart.workspacePath),
        queuedMs,
      },
      ...(capturesSummaries(this.emitter.capturePolicy)
        ? { summary: { text: redactText(run.prompt).text.slice(0, 240), policy: "safe_summary" as const } }
        : {}),
    });
    this.spans.set(run.id, { traceId: ctx.traceId, rootSpanId: ctx.rootSpanId, agentId: agentAtStart.id });
    const execution = this.executeRun(agentAtStart, run, {});
    this.activeExecutions.set(agentAtStart.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentAtStart.id) === execution) {
          this.activeExecutions.delete(agentAtStart.id);
        }
      })
      .catch(() => undefined);
  }

  /** Atomically claims a `ready` Agent and starts its next pending message, if any (restart/start resume). */
  private async dequeueAndStart(agentId: string, restartNote?: string): Promise<void> {
    // Without a configured model every dequeued Run would fail instantly and burn the queue; keep it queued.
    if (!isModelConfigured(this.config)) return;
    const ctx = createTraceContext({}, this.emitter.capturePolicy);
    const dequeued = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent || agent.status !== "ready") return undefined;
      return this.dequeueNext(database, agent, ctx);
    });
    if (dequeued) this.startDequeuedRun(dequeued, restartNote);
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
    const bindings = run.traceId ? { traceId: run.traceId, runId: run.id, agentId: run.agentId } : undefined;
    const logger = bindings ? this.runLogs?.child({ ...bindings, component: "AgentService" }) : undefined;
    const runnerLogger = bindings ? this.runLogs?.child({ ...bindings, component: "AgentRunner" }) : undefined;
    const pino = bindings ? this.appLogger?.child(bindings) : undefined;
    const startedAtMs = Date.now();
    const durationSeconds = () => Math.round((Date.now() - startedAtMs) / 1000);
    let verify: VerifyOutcome | undefined;
    try {
      pino?.info("Run started");
      await logger?.info("Run started").catch(() => undefined);
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
        // Best-effort live status for the polled Run (#223). Fire-and-forget: a failed write can
        // never reach the runner or change the Run's outcome (invariant 4). Writes are coalesced —
        // at most one store mutation in flight; a burst of events collapses to the latest state —
        // so a chatty stream can't queue a disk write per event behind the terminal write.
        onActivity: (() => {
          let latest: RunActivity | null = null;
          let written: RunActivity | null = null;
          let writing = false;
          const flush = (): void => {
            if (writing) return;
            writing = true;
            const next = latest;
            void this.store
              .mutate((database) => {
                const storedRun = database.runs.find((item) => item.id === run.id);
                if (storedRun && storedRun.status === "running") {
                  storedRun.currentActivity = next ?? undefined;
                }
              })
              .catch(() => undefined)
              .then(() => {
                writing = false;
                written = next;
                if (latest !== written) flush();
              });
          };
          return (activity: RunActivity | null) => {
            latest = activity;
            flush();
          };
        })(),
        ...(bindings
          ? {
              logger: {
                // Messages can carry stream-derived text (a command's argument0 may be a `SECRET=…`
                // assignment): pino writes to stdout with no redaction of its own, so redact here.
                // RunLogStore.append re-redacts its copy — defense in depth, not duplication.
                info: (message: string) => {
                  pino?.info(redactText(message, [LOG_SECRET_ASSIGNMENT]).text);
                  void runnerLogger?.info(message).catch(() => undefined);
                },
                warn: (message: string) => {
                  pino?.warn?.(redactText(message, [LOG_SECRET_ASSIGNMENT]).text);
                  void runnerLogger?.warn(message).catch(() => undefined);
                },
                error: (message: string, error?: unknown) => {
                  // Never hand pino the Error itself: its err serializer writes message/stack verbatim to stdout.
                  const detail = error === undefined ? undefined : redactText(String(error)).text.slice(0, 2_048);
                  pino?.error(detail ? { detail } : {}, redactText(message, [LOG_SECRET_ASSIGNMENT]).text);
                  void runnerLogger?.error(message, detail).catch(() => undefined);
                },
              },
            }
          : {}),
      });
      if (workspaceBefore && ids && service) {
        const workspaceAfter = await snapshotWorkspace(agentAtStart.workspacePath).catch(() => undefined);
        if (workspaceAfter) {
          const changes = diffWorkspace(workspaceBefore, workspaceAfter);
          const changesLine = `Workspace changed: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.removed.length} removed`;
          pino?.info(changesLine);
          await logger?.info(changesLine).catch(() => undefined);
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
      // Completion summary (#232): metadata-only counters the runner observed, no content.
      const summaryLine = [
        "Run completed: status=completed duration=" + durationSeconds() + "s",
        ...(result.stats
          ? [
              "modelCalls=" + result.stats.modelCalls,
              "toolCalls=" + result.stats.toolCalls,
              "toolFailures=" + result.stats.toolFailures,
              "sandboxDenials=" + result.stats.sandboxDenials,
            ]
          : []),
        ...(result.usage?.inputTokens !== undefined ? ["tokensIn=" + result.usage.inputTokens] : []),
        ...(result.usage?.outputTokens !== undefined ? ["tokensOut=" + result.usage.outputTokens] : []),
      ].join(" ");
      pino?.info(summaryLine);
      await logger?.info(summaryLine).catch(() => undefined);
      const queueCtx = createTraceContext({}, this.emitter.capturePolicy);
      const dequeued = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return undefined;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.currentActivity = undefined;
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
        // #254: dequeue in the same mutation that freed the Agent — the one-active-Run invariant lives here.
        return this.dequeueNext(database, agent, queueCtx);
      });
      // #254 vs #253 ordering: the Agent is ready the moment the mutate commits, so the next queued Run
      // starts now and does NOT wait for the verify below — the same accepted window as a user message
      // arriving during a slow verify (see the ponytail note under the verify block).
      if (dequeued) this.startDequeuedRun(dequeued);
      // #253: operator-set verification of a completed ordinary Run. Eval-isolated Runs (the only callers
      // that pass options.workspacePath) keep their own post_check assertion machinery. The verdict is a
      // separate judgement stamped on the RunSummary — it must never change the Run's terminal status, and
      // an infrastructure failure of the check itself leaves the outcome unknown.
      // ponytail: the Agent is already `ready`, so a message sent during a slow verify starts run N+1 in
      // the same workspace and this verdict measures post-N+1 state; serialize via a workspace claim if
      // that window ever bites — for a ~seconds-long check it is the honest cheap trade.
      if (agentAtStart.verifyCommand && options.workspacePath === undefined) {
        try {
          const check = await new PostCheckRunner(this.config, this.emitter).run({
            workspacePath: agentAtStart.workspacePath,
            command: agentAtStart.verifyCommand,
            timeoutMs: VERIFY_TIMEOUT_MS,
            ...(ids && service
              ? { trace: { traceId: ids.traceId, runId: run.id, agentId: agentAtStart.id, parentSpanId: service.spanId } }
              : {}),
          });
          if (check.signal !== null) {
            // Killed (the runner's timeout path): not a real exit code, so no verdict.
            const line = "Verify command did not finish within " + VERIFY_TIMEOUT_MS + " ms";
            pino?.error({}, line);
            await runnerLogger?.error(line).catch(() => undefined);
          } else {
            verify = { taskOutcome: check.exitCode === 0 ? "passed" : "failed", source: VERIFY_OUTCOME_SOURCE };
            const line = "Verify command exited " + check.exitCode + " (taskOutcome=" + verify.taskOutcome + ")";
            pino?.info(line);
            await runnerLogger?.info(line).catch(() => undefined);
          }
        } catch (verifyError) {
          const line = "Verify command failed to run";
          const detail = redactText(String(verifyError)).text.slice(0, 2_048);
          pino?.error({ detail }, line);
          await runnerLogger?.error(line, detail).catch(() => undefined);
        }
      }
      if (ids && service) {
        const outcome = describeFinalMessage(result.output);
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
            outputBytes: outcome.finalMessageBytes,
            finalMessageBytes: outcome.finalMessageBytes,
            reportedFailure: outcome.reportedFailure,
            ...(result.usage ?? {}),
          },
          ...(capturesSummaries(this.emitter.capturePolicy)
            ? { summary: { text: outcome.summaryText, policy: "safe_summary" as const } }
            : {}),
          ...(result.threadId ? { sessionId: result.threadId } : {}),
        });
        service.end("ok", { type: "agent_service.run.completed" });
      }
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelled) {
        const logMessage = (/timed out/i.test(message) ? "Runner timed out" : "Runner failed") + " after " + durationSeconds() + "s";
        const detail = redactText(message).text.slice(0, 2_048);
        pino?.error({ detail }, logMessage);
        await runnerLogger?.error(logMessage, detail).catch(() => undefined);
      } else {
        const logMessage = "Run cancelled after " + durationSeconds() + "s";
        pino?.info(logMessage);
        await logger?.error(logMessage).catch(() => undefined);
      }
      const queueCtx = createTraceContext({}, this.emitter.capturePolicy);
      const dequeued = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.currentActivity = undefined;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            // #266: a failed Run leaves the Agent `ready` — the Run keeps the error evidence and
            // `lastError` carries it for the UI (redacted: unlike the Run's own error it is rendered
            // outside the trace surfaces). Nothing gated on `error`, so nothing produces it anymore;
            // the AgentStatus member stays for stored-data/API compatibility and initialize() migrates it.
            agent.status = "ready";
          }
          agent.lastError = cancelled ? null : redactText(message).text.slice(0, 2_048);
          agent.updatedAt = completedAt;
          // #254: a failed Run still frees the Agent for the rest of the batch (the failed Run keeps
          // its error evidence). A cancel is a user "stop"/delete gesture — auto-starting queued work
          // would fight it (stopAgent sets `stopped` right after this settles), so the queue is kept
          // but not started; startAgent resumes it.
          if (!cancelled && agent.status !== "stopped") {
            return this.dequeueNext(database, agent, queueCtx);
          }
        }
        return undefined;
      });
      if (dequeued) this.startDequeuedRun(dequeued);
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
      this.onRunEnded?.(run.id, verify);
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
