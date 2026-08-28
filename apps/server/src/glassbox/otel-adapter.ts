import type { CapturePolicy, TraceStatus } from "./schema.js";
import { buildTrace, flattenSpans, type Span } from "./query.js";
import type { TraceStore } from "./store.js";

export interface OtelSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  startTime: string;
  endTime?: string | undefined;
  status: "UNSET" | "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

const otelStatus = (status: TraceStatus): OtelSpanRecord["status"] =>
  status === "ok" ? "OK" : status === "running" || status === "unset" ? "UNSET" : "ERROR";

function semanticAttributes(span: Span, capturePolicy: CapturePolicy): OtelSpanRecord["attributes"] {
  const attributes: OtelSpanRecord["attributes"] = {
    "glassbox.category": span.category,
    "glassbox.capture_policy": capturePolicy,
    "glassbox.source.component": span.source.component,
    "glassbox.source.observed": span.source.observed,
    "glassbox.incomplete": span.incomplete,
  };
  if (span.category === "model") attributes["gen_ai.operation.name"] = "chat";
  if (span.category === "tool") attributes["gen_ai.operation.name"] = "execute_tool";
  return attributes;
}

/**
 * Read-only export seam. Emitters remain unaware of OpenTelemetry and the stored ObservationEvent
 * contract is unchanged; an OTLP transport can serialize these bounded records later.
 * Content-bearing attributes, summaries and errors are deliberately not copied.
 */
export class OtelTraceAdapter {
  constructor(private readonly store: TraceStore, private readonly capturePolicy: CapturePolicy) {}

  async readRun(runId: string): Promise<OtelSpanRecord[]> {
    const events = await this.store.readRun(runId);
    if (events.length === 0) return [];
    const view = buildTrace(events, { capturePolicy: this.capturePolicy });
    return flattenSpans(view.spans).map((span) => ({
      traceId: view.summary.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      startTime: span.startedAt,
      ...(span.endedAt ? { endTime: span.endedAt } : {}),
      status: otelStatus(span.status),
      attributes: semanticAttributes(span, this.capturePolicy),
    }));
  }
}
