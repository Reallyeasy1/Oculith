import { SCHEMA_VERSION, newId, type ActorType, type CapturePolicy } from "./schema.js";

/** No `sessionId` slot on purpose: the Codex thread id only exists once the runner observes
 * `thread.started`, and the observer stamps it per-event — nothing populates one at ingress time (#59). */
export interface TraceContext {
  traceId: string;
  rootSpanId: string;
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  actorId: string;
  actorType: ActorType;
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
