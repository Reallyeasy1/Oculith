import { SCHEMA_VERSION, newId, type CapturePolicy } from "./schema.js";

export interface TraceContext {
  traceId: string;
  rootSpanId: string;
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  actorId: string;
  actorType: "human" | "service" | "agent" | "controller";
  capturePolicy: CapturePolicy;
  schemaVersion: typeof SCHEMA_VERSION;
  receivedAt: string;
  /** Filled by AgentService once the Run exists, so the ingress hook can end the root span. */
  runId?: string | undefined;
  agentId?: string | undefined;
}

export function createTraceContext(
  init: { requestId?: string | undefined; method?: string | undefined; path?: string | undefined; actorId?: string | undefined },
  capturePolicy: CapturePolicy,
): TraceContext {
  return {
    traceId: newId("trc"),
    rootSpanId: newId("spn"),
    requestId: init.requestId,
    method: init.method,
    path: init.path,
    actorId: init.actorId ?? "local-user",
    actorType: "human",
    capturePolicy,
    schemaVersion: SCHEMA_VERSION,
    receivedAt: new Date().toISOString(),
  };
}
