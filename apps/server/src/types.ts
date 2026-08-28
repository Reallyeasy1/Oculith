export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface AgentConfigSnapshot {
  instructions: string;
  modelProvider: "ark" | "openai";
  model: string;
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  runtimeProvider: "local-process" | "container";
  containerRuntimeImage: string;
  capturePolicy: "metadata_only" | "safe_summary";
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
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  workspace?: string | undefined;
  template?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  workspace?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
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
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
