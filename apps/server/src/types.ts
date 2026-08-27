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

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  workspace?: string | undefined;
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
