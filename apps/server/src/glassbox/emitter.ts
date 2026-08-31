import { failClosed, redactEvent } from "./redact.js";
import {
  REDACTION_RULESET_VERSION, SCHEMA_VERSION, eventInputSchema, newId, observationEventSchema,
  type CapturePolicy, type EventInput, type EventType, type ObservationEvent, type TraceStatus,
} from "./schema.js";
import { MemoryTraceStore, type AppendResult, type TraceStore } from "./store.js";

/** #358: per-run bound on appends waiting in the chain. Deliberately 2x the store's 1000-event cap: a
 * synchronous burst to a *healthy* store must reach the store and be truncated there (invariant 10 —
 * terminal/error events bypass the store caps), so the queue cap only bites when the store is hung or
 * hopelessly behind. Beyond it: drop + degrade, never grow unbounded. */
export const MAX_QUEUE_DEPTH = 2000;
/** #358: how long one append may take before the run degrades and the chain moves on. 10s is ~1000x the
 * measured fsync append (~6ms) — anything slower is a hung disk/store, not a slow one. */
export const APPEND_TIMEOUT_MS = 10_000;

export interface EmitterOptions {
  store: TraceStore; capturePolicy: CapturePolicy; extraPatterns?: RegExp[] | undefined;
  log?: ((message: string, meta: Record<string, unknown>) => void) | undefined;
  /** #358 test knobs; production wiring keeps the defaults. */
  maxQueueDepth?: number | undefined; appendTimeoutMs?: number | undefined;
  /** #40: fires after an event's append settles (stored or capped), with the redacted event. Wired to
   * the SSE LiveNotifier in index.ts; the emitter itself imports no UI/query code (invariant 9). */
  onEvent?: ((event: ObservationEvent) => void) | undefined;
}
export interface SpanHandle {
  spanId: string;
  end(status: TraceStatus, extra?: { type?: EventType; attributes?: EventInput["attributes"]; error?: EventInput["error"]; summary?: EventInput["summary"]; name?: string; preRedactedRules?: readonly string[] }): ObservationEvent | null;
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
  private readonly runTraces = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  /** #358: appends enqueued but not yet settled, per run; entries are deleted at zero so the map stays small. */
  private readonly queueDepths = new Map<string, number>();
  private readonly maxQueueDepth: number;
  private readonly appendTimeoutMs: number;

  constructor(options: EmitterOptions) {
    this.store = options.store; this.capturePolicy = options.capturePolicy;
    this.extraPatterns = options.extraPatterns ?? [];
    this.onEvent = options.onEvent;
    this.maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
    this.appendTimeoutMs = options.appendTimeoutMs ?? APPEND_TIMEOUT_MS;
    // A throwing log callback must never become a second failure on the emit path (invariant 4).
    const rawLog = options.log ?? (() => undefined);
    this.log = (message, meta) => { try { rawLog(message, meta); } catch { /* swallowed by design */ } };
  }

  seedSequence(traceId: string, lastSequence: number): void {
    // #358: a NaN/non-integer seed (a corrupt store index) would make build()'s schema parse throw on
    // every later emit for this trace. Ignore the poison and keep the counter usable (invariant 4).
    if (!Number.isInteger(lastSequence)) { this.log("seed_sequence_ignored", { traceId, lastSequence: String(lastSequence) }); return; }
    this.sequences.set(traceId, Math.max(this.sequences.get(traceId) ?? -1, lastSequence));
  }
  isDegraded(runId: string): boolean { return this.degradedRuns.has(runId); }
  /** Frees a finished Run's per-run bookkeeping (call after its rollup ran); without this the maps grow
   * one entry per Run for the life of the process (#54). A degraded Run is kept whole: its flag may be the
   * only surviving evidence of the store failure (invariant 4), and degraded Runs are rare by definition.
   * A straggler emitted after eviction (eval post_check landing after a timed-out Run's rollup, #367)
   * reseeds its sequence from the store index on demand — see storedLastSequence(). */
  evictRun(runId: string): void {
    if (this.degradedRuns.has(runId)) return;
    const traceId = this.runTraces.get(runId);
    if (traceId !== undefined) this.sequences.delete(traceId);
    this.runTraces.delete(runId); this.truncatedRuns.delete(runId);
  }
  flush(): Promise<void> { return this.queue; }

  emit(input: EventInput, preRedactedRules: readonly string[] = []): ObservationEvent | null {
    // #358: nothing inside observation may throw into the caller (invariant 4). The known edges (null
    // input, poisoned sequence) are guarded individually; this backstop catches the ones we haven't met.
    try { return this.emitUnsafe(input, preRedactedRules); }
    catch (error) {
      const runId = typeof input === "object" && input !== null && typeof (input as { runId?: unknown }).runId === "string" ? (input as { runId: string }).runId : undefined;
      if (runId !== undefined && !this.degradedRuns.has(runId)) {
        this.degradedRuns.add(runId);
        this.log("telemetry.degraded", { runId, error: String(error).slice(0, 200) });
      } else if (runId === undefined) this.log("emit_failed", { error: String(error).slice(0, 200) });
      return null;
    }
  }

  private emitUnsafe(input: EventInput, preRedactedRules: readonly string[]): ObservationEvent | null {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.quarantine(input, issue ? issue.path.join(".") + ": " + issue.message : "invalid");
      return null;
    }
    const final = this.finalize(parsed.data, preRedactedRules);
    if ("invalid" in final) { this.quarantine(input, "post-redaction: " + final.invalid); return null; }
    this.enqueue(final);
    return final;
  }

  startSpan(input: Omit<EventInput, "phase" | "status">): SpanHandle {
    const spanId = input.spanId ?? newId("spn");
    const startedAt = Date.now();
    let ended = false;
    this.emit({ ...input, spanId, phase: "start", status: "running" });
    return {
      spanId,
      end: (status, extra = {}) => {
        // A span ends once; a second end() would store a duplicate end event and double-count the span.
        // #358: logged, not silent — a double end() is a caller bug worth seeing.
        if (ended) { this.log("duplicate_dropped", { runId: input.runId, spanId, reason: "span_already_ended" }); return null; }
        ended = true;
        return this.emit({
          ...input, spanId, phase: "end", status,
          type: extra.type ?? input.type, name: extra.name ?? input.name,
          durationMs: Math.max(0, Date.now() - startedAt),
          attributes: { ...(input.attributes ?? {}), ...(extra.attributes ?? {}) },
          ...(extra.error ? { error: extra.error } : {}), ...(extra.summary ? { summary: extra.summary } : {}),
        }, extra.preRedactedRules);
      },
    };
  }

  /** #367: a straggler emitted after evictRun (eval post_check lands after a timed-out Run's rollup+evict)
   * must continue its trace's sequence, not restart at 0 and serve at the top of the timeline. The store
   * index already records lastSequence per run (seedSequence restores from it on boot) and is synchronously
   * readable, so reseed from it on a counter miss. A brand-new trace misses runIdForTrace and pays nothing;
   * only a genuine straggler pays the listRuns scan, once — build() re-caches the counter.
   * ponytail: the re-cached entry is never evicted again (nobody calls evictRun twice) — one tiny map
   * entry per straggler run for process life; wire a second evict if stragglers ever stop being rare. */
  private storedLastSequence(traceId: string): number {
    const runId = this.store.runIdForTrace(traceId);
    if (runId === undefined) return -1;
    return this.store.listRuns().find((entry) => entry.runId === runId)?.lastSequence ?? -1;
  }

  private build(data: ReturnType<typeof eventInputSchema.parse>): ObservationEvent {
    // The sequence is claimed here, before redaction/append: an event later quarantined or dropped by a
    // cap leaves a gap in the stored sequences. Gaps are expected; readers must not assume density.
    const next = (this.sequences.get(data.traceId) ?? this.storedLastSequence(data.traceId)) + 1;
    this.sequences.set(data.traceId, next);
    this.runTraces.set(data.runId, data.traceId);
    return observationEventSchema.parse({
      ...data, schemaVersion: SCHEMA_VERSION, eventId: newId("evt"), sequence: next,
      timestamp: data.timestamp ?? new Date().toISOString(),
      privacy: { redacted: false, rulesetVersion: REDACTION_RULESET_VERSION },
    });
  }

  /** build -> redact (fail-closed on redactor throw) -> re-validate. Shared by emit(), quarantine()
   * and the truncation/degraded system events so nothing reaches the store without passing redaction.
   * On post-redaction failure returns the specific zod issue so the quarantine reason names it (#54). */
  private finalize(data: ReturnType<typeof eventInputSchema.parse>, preRedactedRules: readonly string[] = []): ObservationEvent | { invalid: string } {
    const event = this.build(data);
    let safe: ObservationEvent;
    try { safe = redactEvent(event, { policy: this.capturePolicy, extraPatterns: this.extraPatterns, preRedactedRules }); }
    catch (error) { safe = failClosed(event); this.log("redaction_failed_closed", { runId: event.runId, error: String(error) }); }
    const final = observationEventSchema.safeParse(safe);
    if (final.success) return final.data;
    const issue = final.error.issues[0];
    return { invalid: issue ? issue.path.join(".") + ": " + issue.message : "invalid" };
  }

  private quarantine(input: EventInput, reason: string): void {
    // #358: input can be null/undefined here (safeParse rejected it, but property reads would throw).
    const source = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    // `?? "unknown"` alone would miss an explicit empty string (still not a usable id); `|| "unknown"`
    // catches both undefined and "".
    const rawType = String(source.type ?? "unknown");
    const traceId = String(source.traceId ?? "unknown") || "unknown";
    const runId = String(source.runId ?? "unknown") || "unknown";
    const agentId = String(source.agentId ?? "unknown") || "unknown";
    if (traceId === "unknown" || runId === "unknown") { this.log("quarantine_dropped", { reason }); return; }
    const fallback = eventInputSchema.safeParse({
      traceId, runId, agentId, spanId: newId("spn"), type: "error.recorded", category: "control", name: "error.recorded", status: "error",
      source: { component: "GlassBox", observed: true },
      attributes: { quarantinedType: rawType, reason: reason.slice(0, 200) },
    });
    if (!fallback.success) { this.log("quarantine_dropped", { reason, quarantinedType: rawType }); return; }
    const final = this.finalize(fallback.data);
    if ("invalid" in final) this.log("quarantine_dropped", { reason, quarantinedType: rawType, invalid: final.invalid });
    else this.enqueue(final);
  }

  /** #358: an append that never settles must not wedge the chain (invariant 4). Race it against a timeout;
   * the pre-attached catch keeps a rejection that lands *after* the timeout won from becoming an
   * unhandled rejection. On timeout the caller's catch degrades the run and the chain moves on. */
  private appendWithTimeout(event: ObservationEvent): Promise<AppendResult> {
    const append = this.store.append(event);
    append.catch(() => undefined); // observed even if the timeout wins the race below
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("append timed out after " + this.appendTimeoutMs + "ms")), this.appendTimeoutMs); });
    return Promise.race([append, timeout]).finally(() => clearTimeout(timer));
  }

  private enqueue(event: ObservationEvent): void {
    // #358: bound the per-run backlog. Past the cap the store is hung or hopelessly behind — drop the
    // event and flag the run degraded (once) instead of growing the chain without bound.
    const depth = this.queueDepths.get(event.runId) ?? 0;
    if (depth >= this.maxQueueDepth) {
      if (!this.degradedRuns.has(event.runId)) {
        this.degradedRuns.add(event.runId);
        this.log("telemetry.degraded", { runId: event.runId, traceId: event.traceId, error: "queue depth cap exceeded (" + this.maxQueueDepth + ")" });
      }
      return;
    }
    this.queueDepths.set(event.runId, depth + 1);
    this.queue = this.queue.then(async () => {
      try {
        const result = await this.appendWithTimeout(event);
        // #40: notify after the append settles so a client refetch sees the stored data. A throwing
        // listener must never surface as a store failure (invariant 4).
        try { this.onEvent?.(event); } catch { /* swallowed */ }
        if (!result.stored && result.reason === "duplicate") this.log("duplicate_dropped", { runId: event.runId, eventId: event.eventId });
        if (!result.stored && (result.reason === "cap_events" || result.reason === "cap_bytes") && !this.truncatedRuns.has(event.runId)) {
          this.truncatedRuns.add(event.runId); this.store.markTruncated(event.runId);
          const t = eventInputSchema.parse({ traceId: event.traceId, runId: event.runId, agentId: event.agentId, spanId: newId("spn"), type: "trace.truncated", category: "control", name: "trace.truncated", status: "unset", source: { component: "GlassBox", observed: true }, attributes: { reason: result.reason } });
          const finalT = this.finalize(t);
          if (!("invalid" in finalT)) await this.appendWithTimeout(finalT);
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
            if (!("invalid" in finalDegraded)) await this.appendWithTimeout(finalDegraded);
          } catch { /* best-effort only */ }
        }
      } finally {
        const remaining = (this.queueDepths.get(event.runId) ?? 1) - 1;
        if (remaining <= 0) this.queueDepths.delete(event.runId); else this.queueDepths.set(event.runId, remaining);
      }
    });
  }
}

export function createDefaultEmitter(): ObservationEmitter {
  return new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only" });
}
