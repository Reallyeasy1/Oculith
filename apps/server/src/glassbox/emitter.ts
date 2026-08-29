import { failClosed, redactEvent } from "./redact.js";
import {
  REDACTION_RULESET_VERSION, SCHEMA_VERSION, eventInputSchema, newId, observationEventSchema,
  type CapturePolicy, type EventInput, type EventType, type ObservationEvent, type TraceStatus,
} from "./schema.js";
import { MemoryTraceStore, type TraceStore } from "./store.js";

export interface EmitterOptions {
  store: TraceStore; capturePolicy: CapturePolicy; extraPatterns?: RegExp[] | undefined;
  log?: ((message: string, meta: Record<string, unknown>) => void) | undefined;
  /** #40: fires after an event's append settles (stored or capped), with the redacted event. Wired to
   * the SSE LiveNotifier in index.ts; the emitter itself imports no UI/query code (invariant 9). */
  onEvent?: ((event: ObservationEvent) => void) | undefined;
}
export interface SpanHandle {
  spanId: string;
  end(status: TraceStatus, extra?: { type?: EventType; attributes?: EventInput["attributes"]; error?: EventInput["error"]; summary?: EventInput["summary"]; name?: string }): ObservationEvent | null;
}

export class ObservationEmitter {
  readonly capturePolicy: CapturePolicy;
  private readonly store: TraceStore;
  private readonly extraPatterns: RegExp[];
  private readonly log: (message: string, meta: Record<string, unknown>) => void;
  private readonly onEvent: ((event: ObservationEvent) => void) | undefined;
  private readonly sequences = new Map<string, number>();
  private readonly degradedRuns = new Set<string>();
  private readonly truncatedRuns = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: EmitterOptions) {
    this.store = options.store; this.capturePolicy = options.capturePolicy;
    this.extraPatterns = options.extraPatterns ?? []; this.log = options.log ?? (() => undefined);
    this.onEvent = options.onEvent;
  }

  seedSequence(traceId: string, lastSequence: number): void {
    this.sequences.set(traceId, Math.max(this.sequences.get(traceId) ?? -1, lastSequence));
  }
  isDegraded(runId: string): boolean { return this.degradedRuns.has(runId); }
  flush(): Promise<void> { return this.queue; }

  emit(input: EventInput): ObservationEvent | null {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.quarantine(input, issue ? issue.path.join(".") + ": " + issue.message : "invalid");
      return null;
    }
    const final = this.finalize(parsed.data);
    if (!final) { this.quarantine(input, "post-redaction: invalid"); return null; }
    this.enqueue(final);
    return final;
  }

  startSpan(input: Omit<EventInput, "phase" | "status">): SpanHandle {
    const spanId = input.spanId ?? newId("spn");
    const startedAt = Date.now();
    this.emit({ ...input, spanId, phase: "start", status: "running" });
    return {
      spanId,
      end: (status, extra = {}) => this.emit({
        ...input, spanId, phase: "end", status,
        type: extra.type ?? input.type, name: extra.name ?? input.name,
        durationMs: Math.max(0, Date.now() - startedAt),
        attributes: { ...(input.attributes ?? {}), ...(extra.attributes ?? {}) },
        ...(extra.error ? { error: extra.error } : {}), ...(extra.summary ? { summary: extra.summary } : {}),
      }),
    };
  }

  private build(data: ReturnType<typeof eventInputSchema.parse>): ObservationEvent {
    const next = (this.sequences.get(data.traceId) ?? -1) + 1;
    this.sequences.set(data.traceId, next);
    return observationEventSchema.parse({
      ...data, schemaVersion: SCHEMA_VERSION, eventId: newId("evt"), sequence: next,
      timestamp: data.timestamp ?? new Date().toISOString(),
      privacy: { redacted: false, rulesetVersion: REDACTION_RULESET_VERSION },
    });
  }

  /** build -> redact (fail-closed on redactor throw) -> re-validate. Shared by emit(), quarantine()
   * and the truncation/degraded system events so nothing reaches the store without passing redaction. */
  private finalize(data: ReturnType<typeof eventInputSchema.parse>): ObservationEvent | null {
    const event = this.build(data);
    let safe: ObservationEvent;
    try { safe = redactEvent(event, { policy: this.capturePolicy, extraPatterns: this.extraPatterns }); }
    catch (error) { safe = failClosed(event); this.log("redaction_failed_closed", { runId: event.runId, error: String(error) }); }
    const final = observationEventSchema.safeParse(safe);
    return final.success ? final.data : null;
  }

  private quarantine(input: EventInput, reason: string): void {
    // `?? "unknown"` alone would miss an explicit empty string (still not a usable id); `|| "unknown"`
    // catches both undefined and "".
    const rawType = String((input as { type?: unknown }).type ?? "unknown");
    const traceId = String((input as { traceId?: unknown }).traceId ?? "unknown") || "unknown";
    const runId = String((input as { runId?: unknown }).runId ?? "unknown") || "unknown";
    const agentId = String((input as { agentId?: unknown }).agentId ?? "unknown") || "unknown";
    if (traceId === "unknown" || runId === "unknown") { this.log("quarantine_dropped", { reason }); return; }
    const fallback = eventInputSchema.safeParse({
      traceId, runId, agentId, spanId: newId("spn"), type: "error.recorded", category: "control", name: "error.recorded", status: "error",
      source: { component: "GlassBox", observed: true },
      attributes: { quarantinedType: rawType, reason: reason.slice(0, 200) },
    });
    if (!fallback.success) { this.log("quarantine_dropped", { reason, quarantinedType: rawType }); return; }
    const final = this.finalize(fallback.data);
    if (final) this.enqueue(final);
    else this.log("quarantine_dropped", { reason, quarantinedType: rawType });
  }

  private enqueue(event: ObservationEvent): void {
    this.queue = this.queue.then(async () => {
      try {
        const result = await this.store.append(event);
        // #40: notify after the append settles so a client refetch sees the stored data. A throwing
        // listener must never surface as a store failure (invariant 4).
        try { this.onEvent?.(event); } catch { /* swallowed */ }
        if (!result.stored && (result.reason === "cap_events" || result.reason === "cap_bytes") && !this.truncatedRuns.has(event.runId)) {
          this.truncatedRuns.add(event.runId); this.store.markTruncated(event.runId);
          const t = eventInputSchema.parse({ traceId: event.traceId, runId: event.runId, agentId: event.agentId, spanId: newId("spn"), type: "trace.truncated", category: "control", name: "trace.truncated", status: "unset", source: { component: "GlassBox", observed: true }, attributes: { reason: result.reason } });
          const finalT = this.finalize(t);
          if (finalT) await this.store.append(finalT);
        }
      } catch (error) {
        if (!this.degradedRuns.has(event.runId)) {
          this.degradedRuns.add(event.runId);
          this.log("telemetry.degraded", { runId: event.runId, traceId: event.traceId, error: String(error).slice(0, 200) });
          // Best-effort: persist a durable marker so degraded mode survives a process restart. Swallow
          // failures here — we already logged above, and this must never surface as a second failure.
          try {
            const degraded = eventInputSchema.parse({ traceId: event.traceId, runId: event.runId, agentId: event.agentId, spanId: newId("spn"), type: "telemetry.degraded", category: "control", name: "telemetry.degraded", status: "error", source: { component: "GlassBox", observed: true }, attributes: { error: String(error).slice(0, 200) } });
            const finalDegraded = this.finalize(degraded);
            if (finalDegraded) await this.store.append(finalDegraded);
          } catch { /* best-effort only */ }
        }
      }
    });
  }
}

export function createDefaultEmitter(): ObservationEmitter {
  return new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only" });
}
