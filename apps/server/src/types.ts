/** `error` is legacy (#266): a failed Run now leaves the Agent `ready` with `lastError` set — the Run
 * carries the error evidence. Nothing produces `error` anymore; the member stays only so stored data
 * from older versions still parses (initialize() migrates it to `ready`). */
export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/** One message accepted while the Agent was busy (#254); becomes a Run + user Message when dequeued. */
export interface PendingMessage {
  id: string;
  content: string;
  queuedAt: string;
}

/** Per-Agent daily spend cap (#255). Enforced pre-run only: Codex reports usage at turn end, so a
 * single Run can overshoot the cap — the gate refuses the next one. "Day" is a rolling 24 h window. */
export interface AgentBudget {
  maxTokensPerDay?: number | undefined;
  maxEstimatedUsdPerDay?: number | undefined;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  workspaceName?: string | undefined;
  workspaceManaged?: boolean | undefined;
  workspaceTemplate?: string | undefined;
  /** Operator-set shell command run in the workspace after every completed ordinary Run (#253); its exit code sets the Run's taskOutcome. */
  verifyCommand?: string | undefined;
  /** Optional daily budget (#255); absent means no gate. No Database version bump — old files lack the key. */
  budget?: AgentBudget | undefined;
  /** FIFO of messages accepted while busy (#254), capped at 10; absent means empty. No Database
   * version bump: old files simply lack the key, and old readers ignore it — the shape stays compatible. */
  pendingMessages?: PendingMessage[] | undefined;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 202 body when a busy Agent queued the message instead of starting a Run (#254).
 * `position` is the 1-based place in the queue; with exactly one Run always active while
 * queueing, it also equals the number of work items ahead. */
export interface QueuedMessageReceipt {
  queued: true;
  position: number;
  messageId: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/** Live "what is Codex doing right now" summary derived from the observed runtime stream. */
export interface RunActivity {
  kind: "thinking" | "command" | "file_change" | "web_search" | "mcp_tool_call";
  label: string;
}

export interface AgentConfigSnapshot {
  instructions: string;
  modelProvider: "ark" | "openai";
  model: string;
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  runtimeProvider: "local-process" | "container";
  containerRuntimeImage: string;
  /** Runtime resource limits are optional so persisted pre-#174 snapshots remain readable. */
  containerCpuLimit?: number | undefined;
  containerMemoryLimit?: string | undefined;
  containerPidsLimit?: number | undefined;
  capturePolicy: "metadata_only" | "safe_summary" | "reasoning_summary";
  /** sha256 of the Agent's verifyCommand (hashed like `instructions`); absent when none is set. */
  verifyCommand?: string | undefined;
  /** Budget limits (#255) are plain numbers, not secrets; absent when unset so pre-budget hashes stay stable. */
  budgetMaxTokensPerDay?: number | undefined;
  budgetMaxEstimatedUsdPerDay?: number | undefined;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  traceId?: string | undefined;
  /** Persisted observation parent used to attach restart cancellation after in-memory span handles are lost. */
  traceParentSpanId?: string | undefined;
  configHash?: string | undefined;
  configSnapshot?: AgentConfigSnapshot | undefined;
  /** Live activity observed from the runtime stream (#223); set best-effort while `running`, cleared on terminal states. */
  currentActivity?: RunActivity | undefined;
}

export interface RegressionCase {
  id: string;
  name: string;
  prompt: string;
  workspaceTemplate: string;
  sourceRunId?: string | undefined;
  baselineConfigHash: string;
  /** sha256 of the template tree when the case was recorded; absent on cases saved before #176 (treated as unknown). */
  templateHash?: string | undefined;
  assertions: import("./eval/evaluators.js").Assertion[];
  createdAt: string;
}

export interface EvalRun {
  id: string;
  caseIds: string[];
  target: { agentId: string; configHash: string; snapshot: AgentConfigSnapshot };
  runIds: string[];
  results: { caseId: string; runId?: string | undefined; results: import("./eval/evaluators.js").EvalResult[]; error?: string | undefined }[];
  status: "running" | "completed" | "failed";
  /** Template name -> content hash at EvalRun start; compare flags baseline/candidate pairs whose hashes differ. */
  templateHashes?: Record<string, string> | undefined;
  /** Set when a case's recorded templateHash no longer matched at start and the caller forced the EvalRun anyway. */
  templateHashMismatch?: boolean | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  regressionCases: RegressionCase[];
  evalRuns: EvalRun[];
  runSummaries: import("./glassbox/summary.js").RunSummary[];
  evaluatorDefinitions: import("./glassbox/evaluation.js").EvaluatorDefinition[];
  evaluationResults: import("./glassbox/evaluation.js").EvaluationResult[];
  evaluationJobs: import("./glassbox/jobs.js").EvaluationJob[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  workspace?: string | undefined;
  template?: string | undefined;
  verifyCommand?: string | undefined;
  budget?: AgentBudget | null | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  workspace?: string | undefined;
  /** Empty string clears the command. */
  verifyCommand?: string | undefined;
  /** `null` (or a budget with no limits) clears the stored budget (#255). */
  budget?: AgentBudget | null | undefined;
}

/** Bounded per-Run counters observed from the runtime stream; feeds the completion-summary log line (#232). */
export interface RunnerRunStats {
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  sandboxDenials: number;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  stats?: RunnerRunStats | undefined;
}

export interface RunnerTraceContext {
  traceId: string;
  runId: string;
  agentId: string;
  parentSpanId: string;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  trace?: RunnerTraceContext | undefined;
  timeoutMs?: number | undefined;
  logger?: RunnerLogger | undefined;
  /** Best-effort live activity updates from the runtime stream; `null` means "nothing in flight".
   * Implementations must treat this as fire-and-forget — it must never throw into the run path. */
  onActivity?: ((activity: RunActivity | null) => void) | undefined;
}

export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
