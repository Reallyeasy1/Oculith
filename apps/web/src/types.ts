export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  workspaceName?: string;
  workspaceManaged?: boolean;
  workspaceTemplate?: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  traceId?: string;
  traceParentSpanId?: string;
  configHash?: string;
  configSnapshot?: AgentConfigSnapshot;
}

export interface AgentConfigSnapshot {
  instructions: string;
  modelProvider: "ark" | "openai";
  model: string;
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  runtimeProvider: "local-process" | "container";
  containerRuntimeImage: string;
  capturePolicy: CapturePolicy;
}

// --- GlassBox query types (mirrors apps/server/src/glassbox/{schema,query}.ts) ---

export type TraceStatus = "running" | "ok" | "error" | "cancelled" | "timeout" | "unset";
export type Category =
  | "experience"
  | "control"
  | "runtime"
  | "model"
  | "tool"
  | "workspace"
  | "sandbox"
  | "policy"
  | "infrastructure";
export type CapturePolicy = "metadata_only" | "safe_summary";

export interface RunListItem {
  runId: string;
  traceId: string;
  agentId: string;
  agentName: string;
  workspace?: string;
  status: TraceStatus;
  startedAt?: string;
  durationMs?: number;
  endedReason?: "server_restart";
  firstFailingStep?: string;
  eventCount: number;
  runtime: string;
  model: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  capabilities: { model: "observed" | "unavailable" | "unknown"; tool: "observed" | "unavailable" | "unknown" };
  toolCalls: number;
  toolFailures: number;
  tokens?: { output?: number };
  denials: number;
  actions: number;
  configHash?: string;
  configSnapshot?: AgentConfigSnapshot;
  workspaceChanges?: { added: number; modified: number; removed: number; bytesDelta: number; truncated: boolean };
  degraded: boolean;
  truncated: boolean;
  /** Content events were removed by retention cleanup (age/disk cap); terminal/error evidence is kept. */
  evicted: boolean;
  redacted: boolean;
  lastEventAt?: string;
}

export interface FailureFocus {
  kind: "error" | "timeout" | "cancelled" | "denied" | "degraded";
  spanId: string;
  eventId: string;
  sequence: number;
  name: string;
  category: Category;
  component: string;
  message?: string;
  path: string[];
  diagnosis: string;
}

export type AuditOutcome = "allowed" | "denied" | "ok" | "error" | "timeout" | "cancelled";
export interface AuditRow {
  at: string;
  actor: { type: ObservationEvent["actorType"]; id: string };
  action: string;
  resource: string;
  outcome: AuditOutcome;
  eventId: string;
  spanId: string;
  traceId: string;
  attributes: ObservationEvent["attributes"];
}

export interface TraceSummary {
  schemaVersion: "1.0";
  capturePolicy: CapturePolicy;
  runId: string;
  traceId: string;
  agentId: string;
  sessionId?: string;
  workspace?: string;
  status: TraceStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Run closed by a server restart: durationMs stops at the last event observed before it. */
  endedReason?: "server_restart";
  eventCount: number;
  spanCount: number;
  incompleteSpans: number;
  redactedEvents: number;
  denials: number;
  audit: { actions: number; denials: number; actors: string[] };
  degraded: boolean;
  truncated: boolean;
  /** Content events were removed by retention cleanup (age/disk cap); terminal/error evidence is kept. */
  evicted: boolean;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  metrics: {
    durationMs?: number;
    terminalStatus: TraceStatus;
    toolCalls: number;
    toolFailures: number;
    modelCalls: number;
    timeToFirstToolMs?: number;
    timeSplit: { modelMs: number; toolMs: number; containerStartMs: number };
    tokens?: { input?: number; cachedInput?: number; output?: number };
    retries: number;
    denials: number;
  };
  configHash?: string;
  capabilities: { model: "observed" | "unavailable" | "unknown"; tool: "observed" | "unavailable" | "unknown" };
  workspaceChanges?: { added: number; modified: number; removed: number; bytesDelta: number; truncated: boolean };
  firstFailingStep?: string;
  failure?: FailureFocus;
}

export interface ObservationEvent {
  schemaVersion: "1.0";
  eventId: string;
  sequence: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  agentId: string;
  sessionId?: string;
  requestId?: string;
  actorId: string;
  actorType: "human" | "service" | "agent" | "controller";
  attempt: number;
  timestamp: string;
  type: string;
  category: Category;
  phase: "start" | "end" | "instant";
  status: TraceStatus;
  name: string;
  durationMs?: number;
  source: { component: string; adapter?: string; observed: boolean };
  attributes: Record<string, string | number | boolean | null>;
  summary?: { text: string; policy: "safe_summary" };
  error?: { type: string; message: string };
  privacy: {
    redacted: boolean;
    rulesetVersion: string;
    reason?: string;
    rules?: string[];
    originalBytes?: number;
    storedBytes?: number;
  };
}

export interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  category: Category;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  incomplete: boolean;
  sequence: number;
  source: ObservationEvent["source"];
  attributes: ObservationEvent["attributes"];
  summary?: ObservationEvent["summary"];
  error?: ObservationEvent["error"];
  events: ObservationEvent[];
  children: Span[];
  depth: number;
}

export interface TraceView {
  summary: TraceSummary;
  spans: Span[];
  events: ObservationEvent[];
}

export interface SystemInfo {
  modelConfigured: boolean;
  modelProvider: "ark" | "openai";
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export type Assertion =
  | { type: "terminal_status"; expected: "ok" | "error" | "timeout" | "cancelled" }
  | { type: "expected_tool"; program: string }
  | { type: "max_tool_calls"; max: number }
  | { type: "max_duration_ms"; max: number }
  | { type: "post_check"; command: string; timeoutMs: number };

export interface RegressionCase {
  id: string; name: string; prompt: string; workspaceTemplate: string; sourceRunId?: string;
  baselineConfigHash: string; assertions: Assertion[]; createdAt: string;
}

export interface EvalResult {
  type: Assertion["type"]; pass: boolean; expected: string | number; observed: string | number | null;
  evidenceEventIds: string[]; message: string;
}
export interface EvalRun {
  id: string; caseIds: string[];
  target: { agentId: string; configHash: string; snapshot: AgentConfigSnapshot };
  runIds: string[]; results: { caseId: string; runId?: string; results: EvalResult[]; error?: string }[];
  status: "running" | "completed" | "failed"; createdAt: string; completedAt?: string;
}
export interface EvalComparison {
  cases: { caseId: string; assertions: { type: string; baseline?: EvalResult; candidate?: EvalResult; delta?: number; regression: boolean }[]; regression: boolean; traceLinks: { baseline?: string; candidate?: string } }[];
  regressions: number;
}

// Mirrors WorkspaceManager.listTemplates(): a bad template (symlink, over limits) is reported, not a 500.
export type WorkspaceTemplate = { name: string; fileCount: number; bytes: number } | { name: string; error: string };
