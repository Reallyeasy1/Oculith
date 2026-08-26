export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
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
  denials: number;
  configHash?: string;
  configSnapshot?: AgentConfigSnapshot;
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

export interface TraceSummary {
  schemaVersion: "1.0";
  capturePolicy: CapturePolicy;
  runId: string;
  traceId: string;
  agentId: string;
  sessionId?: string;
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
  degraded: boolean;
  truncated: boolean;
  /** Content events were removed by retention cleanup (age/disk cap); terminal/error evidence is kept. */
  evicted: boolean;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  configHash?: string;
  capabilities: { model: "observed" | "unavailable" | "unknown"; tool: "observed" | "unavailable" | "unknown" };
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
