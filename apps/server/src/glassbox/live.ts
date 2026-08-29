import type { TraceStatus } from "./schema.js";

/** #40: in-process fan-out from the observation plane to SSE clients. index.ts wires the emitter's
 * `onEvent` to `publish`; the `/api/events/stream` route in app.ts subscribes. Notifications carry
 * ids and enums only — clients refetch through the existing REST endpoints, so redaction and the
 * query path stay on the one serializer (invariant 1). */
export interface LiveNotification {
  type: "run.updated";
  runId: string;
  agentId: string;
  status: TraceStatus;
  ts: string;
}

export class LiveNotifier {
  private readonly listeners = new Set<(notification: LiveNotification) => void>();

  constructor(readonly heartbeatMs: number = 15_000) {}

  /** Never throws: a broken SSE client must not reach the Run path (invariant 4). */
  publish(notification: LiveNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // swallowed — telemetry fan-out failures never propagate
      }
    }
  }

  subscribe(listener: (notification: LiveNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** The SSE token travels as `?access_token=` (EventSource cannot set headers); it must never land
 * in the request log. Applied by the request-log serializer in app.ts. */
export function redactAccessToken(url: string): string {
  return url.replace(/([?&]access_token=)[^&]*/g, "$1[REDACTED]");
}
