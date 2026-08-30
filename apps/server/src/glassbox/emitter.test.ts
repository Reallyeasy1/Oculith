import { describe, expect, it } from "vitest";
import { ObservationEmitter, createDefaultEmitter } from "./emitter.js";
import { buildTrace } from "./query.js";
import { MemoryTraceStore, type TraceStore } from "./store.js";
import type { ObservationEvent } from "./schema.js";

const base = { traceId: "trc_1", spanId: "spn_1", runId: "run-1", agentId: "agt-1", type: "run.created" as const, category: "control" as const, name: "run.created", source: { component: "AgentService", observed: true } };

describe("ObservationEmitter", () => {
  it("fills ids, timestamps and monotonic sequence; redacts; stores", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const a = em.emit({ ...base, attributes: { token: "x", note: "Bearer abcdefghijklmnopqrstuvwxyz" } })!;
    const b = em.emit({ ...base, spanId: "spn_2" })!;
    expect(a.eventId.startsWith("evt_")).toBe(true); expect(a.sequence).toBe(0); expect(b.sequence).toBe(1);
    expect(a.attributes).toEqual({ note: "[REDACTED:bearer]" }); expect(a.privacy.redacted).toBe(true);
    await em.flush();
    expect((await store.readRun("run-1")).map((e) => e.sequence)).toEqual([0, 1]);
  });
  it("never awaits the store on emit (append runs on the microtask queue), and never throws when the store rejects", async () => {
    let calls = 0;
    const counting: TraceStore = { async initialize() {}, async append() { calls++; return { stored: true }; }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const em = new ObservationEmitter({ store: counting, capturePolicy: "metadata_only" });
    em.emit(base); expect(calls).toBe(0);
    await em.flush(); expect(calls).toBe(1);
    const bad: TraceStore = { ...counting, async append() { throw new Error("EACCES"); } };
    const logs: string[] = [];
    const em2 = new ObservationEmitter({ store: bad, capturePolicy: "metadata_only", log: (m) => logs.push(m) });
    expect(() => em2.emit(base)).not.toThrow();
    await em2.flush();
    expect(em2.isDegraded("run-1")).toBe(true);
    expect(logs.some((l) => l.includes("telemetry.degraded"))).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
  it("quarantines malformed input as error.recorded", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const out = em.emit({ ...base, status: "done" as never });
    expect(out).toBeNull();
    await em.flush();
    const stored = await store.readRun("run-1");
    expect(stored).toHaveLength(1); expect(stored[0]!.type).toBe("error.recorded"); expect(stored[0]!.attributes.quarantinedType).toBe("run.created");
  });
  it("spans: start/end share spanId, end computes durationMs", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const span = em.startSpan({ ...base, type: "agent_service.run.started", name: "service" });
    await new Promise((r) => setTimeout(r, 15));
    const end = span.end("ok", { type: "agent_service.run.completed" })!;
    expect(end.spanId).toBe(span.spanId); expect(end.phase).toBe("end"); expect(end.durationMs).toBeGreaterThanOrEqual(10);
    await em.flush();
    const [s, e] = await store.readRun("run-1"); expect(s!.phase).toBe("start"); expect(s!.status).toBe("running"); expect(e!.status).toBe("ok");
  });
  it("emits trace.truncated once when the store caps and marks the run", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    for (let i = 0; i < 1002; i++) em.emit({ ...base, spanId: "s" + i, type: "tool.call.completed", category: "tool", name: "t" });
    await em.flush();
    const events: ObservationEvent[] = await store.readRun("run-1");
    expect(events.filter((e) => e.type === "trace.truncated")).toHaveLength(1);
    expect(store.listRuns()[0]!.truncated).toBe(true);
  });
  it("a span can only end once: the second end() is a no-op returning null", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const span = em.startSpan({ ...base, type: "agent_service.run.started", name: "service" });
    expect(span.end("ok", { type: "agent_service.run.completed" })).not.toBeNull();
    expect(span.end("error", { type: "agent_service.run.failed" })).toBeNull();
    await em.flush();
    expect((await store.readRun("run-1")).map((e) => e.phase)).toEqual(["start", "end"]);
  });
  it("logs a duplicate drop instead of discarding it silently", async () => {
    const logs: string[] = [];
    const dup: TraceStore = { async initialize() {}, async append() { return { stored: false, reason: "duplicate" }; }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {}, async cleanup() { return { runs: 0, bytesBefore: 0, bytesAfter: 0, overCap: false, evicted: [] }; } };
    const em = new ObservationEmitter({ store: dup, capturePolicy: "metadata_only", log: (m) => logs.push(m) });
    em.emit(base);
    await em.flush();
    expect(logs).toContain("duplicate_dropped");
  });
  it("a throwing log callback never breaks emit or the queue (invariant 4)", async () => {
    const bad: TraceStore = { async initialize() {}, async append() { throw new Error("EACCES"); }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {}, async cleanup() { return { runs: 0, bytesBefore: 0, bytesAfter: 0, overCap: false, evicted: [] }; } };
    const em = new ObservationEmitter({ store: bad, capturePolicy: "metadata_only", log: () => { throw new Error("logger exploded"); } });
    expect(() => em.emit(base)).not.toThrow();
    await expect(em.flush()).resolves.toBeUndefined();
    expect(em.isDegraded("run-1")).toBe(true);
  });
  it("evictRun frees a finished run's bookkeeping but keeps a degraded run's evidence (invariant 4)", async () => {
    const em = new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only" });
    expect(em.emit(base)!.sequence).toBe(0);
    expect(em.emit({ ...base, spanId: "spn_2" })!.sequence).toBe(1);
    await em.flush();
    em.evictRun("run-1");
    // #367: the evicted counter reseeds from the store index — a straggler continues, it never restarts at 0.
    expect(em.emit(base)!.sequence).toBe(2);
    const bad: TraceStore = { async initialize() {}, async append() { throw new Error("EACCES"); }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {}, async cleanup() { return { runs: 0, bytesBefore: 0, bytesAfter: 0, overCap: false, evicted: [] }; } };
    const degraded = new ObservationEmitter({ store: bad, capturePolicy: "metadata_only" });
    degraded.emit(base);
    await degraded.flush();
    expect(degraded.isDegraded("run-1")).toBe(true);
    degraded.evictRun("run-1");
    expect(degraded.isDegraded("run-1")).toBe(true);
  });
  it("#40: onEvent fires after the append settles, with the redacted event, and a throwing hook never degrades the run", async () => {
    const store = new MemoryTraceStore();
    const seen: ObservationEvent[] = [];
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", onEvent: (e) => seen.push(e) });
    em.emit({ ...base, attributes: { token: "x" } });
    expect(seen).toHaveLength(0); // not before the store append settles
    await em.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe("run-1");
    expect(seen[0]!.attributes.token).toBeUndefined(); // the hook only ever sees redacted events

    const em2 = new ObservationEmitter({ store, capturePolicy: "metadata_only", onEvent: () => { throw new Error("broken listener"); } });
    em2.emit({ ...base, spanId: "spn_9" });
    await em2.flush();
    expect(em2.isDegraded("run-1")).toBe(false);
  });
  it("seedSequence continues after a rebuild", () => {
    const em = createDefaultEmitter(); em.seedSequence("trc_1", 41);
    expect(em.emit(base)!.sequence).toBe(42);
  });
  it("logs and drops a quarantine when ids are empty, instead of silently discarding", async () => {
    const store = new MemoryTraceStore();
    const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", log: (message, meta) => logs.push({ message, meta }) });
    const out = em.emit({ ...base, traceId: "" });
    expect(out).toBeNull();
    await em.flush();
    expect(await store.readRun("run-1")).toEqual([]);
    expect(logs.filter((l) => l.message === "quarantine_dropped")).toHaveLength(1);
  });
  it("redacts the quarantined error.recorded event before storing it", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz";
    const out = em.emit({ ...base, status: secret as never });
    expect(out).toBeNull();
    await em.flush();
    const stored = await store.readRun("run-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.type).toBe("error.recorded");
    expect(String(stored[0]!.attributes.reason)).not.toContain(secret);
  });
  it("persists exactly one telemetry.degraded event on first store failure", async () => {
    const inner = new MemoryTraceStore();
    const store: TraceStore = {
      initialize: () => inner.initialize(),
      append: (event) => (event.type === "telemetry.degraded" ? inner.append(event) : Promise.reject(new Error("boom"))),
      readRun: (runId) => inner.readRun(runId),
      runIdForTrace: (traceId) => inner.runIdForTrace(traceId),
      listRuns: () => inner.listRuns(),
      markTruncated: (runId) => inner.markTruncated(runId),
    };
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    em.emit(base);
    em.emit({ ...base, spanId: "spn_2" });
    await em.flush();
    expect(em.isDegraded("run-1")).toBe(true);
    const stored = await store.readRun("run-1");
    expect(stored.filter((e) => e.type === "telemetry.degraded")).toHaveLength(1);
  });
  it("never throws and stays degraded even when the best-effort persist also fails", async () => {
    const store: TraceStore = { async initialize() {}, async append() { throw new Error("EACCES"); }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const logs: string[] = [];
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", log: (m) => logs.push(m) });
    expect(() => em.emit(base)).not.toThrow();
    await em.flush();
    expect(em.isDegraded("run-1")).toBe(true);
    expect(logs.filter((l) => l === "telemetry.degraded")).toHaveLength(1);
  });
  it("#358: emit(null)/emit(undefined) degrade instead of throwing to the caller (invariant 4)", async () => {
    const store = new MemoryTraceStore();
    const logs: string[] = [];
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", log: (m) => logs.push(m) });
    expect(() => em.emit(null as never)).not.toThrow();
    expect(em.emit(undefined as never)).toBeNull();
    await em.flush();
    expect(logs).toContain("quarantine_dropped");
  });
  it("#358: a non-finite/non-integer seedSequence is ignored instead of poisoning every later emit for the trace", () => {
    const em = createDefaultEmitter();
    em.seedSequence("trc_1", Number.NaN);
    em.seedSequence("trc_1", 1.5);
    const out = em.emit(base);
    expect(out).not.toBeNull();
    expect(out!.sequence).toBe(0);
  });
  it("#358: drops events beyond the per-run queue depth cap and degrades the run, logging once", async () => {
    const hanging: TraceStore = { async initialize() {}, append: () => new Promise(() => {}), async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const logs: string[] = [];
    const em = new ObservationEmitter({ store: hanging, capturePolicy: "metadata_only", log: (m) => logs.push(m), maxQueueDepth: 2, appendTimeoutMs: 10 });
    for (let i = 0; i < 4; i++) em.emit({ ...base, spanId: "s" + i });
    // Events 3 and 4 exceeded the depth cap synchronously: dropped, run degraded, logged exactly once.
    expect(em.isDegraded("run-1")).toBe(true);
    expect(logs.filter((l) => l === "telemetry.degraded")).toHaveLength(1);
    await em.flush();
  });
  it("#358: an append that never settles degrades the run after the settle timeout without wedging the chain", async () => {
    const inner = new MemoryTraceStore();
    let calls = 0;
    const store: TraceStore = {
      initialize: () => inner.initialize(),
      append: (event) => (calls++ === 0 ? new Promise(() => {}) : inner.append(event)), // first append hangs forever
      readRun: (runId) => inner.readRun(runId),
      runIdForTrace: (traceId) => inner.runIdForTrace(traceId),
      listRuns: () => inner.listRuns(),
      markTruncated: (runId) => inner.markTruncated(runId),
    };
    const logs: string[] = [];
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", log: (m) => logs.push(m), appendTimeoutMs: 20 });
    em.emit(base);
    em.emit({ ...base, spanId: "spn_2" });
    await em.flush(); // resolves: the timed-out append must not wedge the chain
    expect(em.isDegraded("run-1")).toBe(true);
    expect(logs.filter((l) => l === "telemetry.degraded")).toHaveLength(1);
    // The chain moved on past the hung append: the second event reached the store.
    expect((await inner.readRun("run-1")).some((e) => e.spanId === "spn_2")).toBe(true);
  });
  it("#358: a late rejection from a timed-out append is observed, never an unhandled rejection", async () => {
    const store: TraceStore = {
      async initialize() {},
      append: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 40)),
      async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {},
    };
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only", appendTimeoutMs: 5 });
    em.emit(base);
    await em.flush();
    expect(em.isDegraded("run-1")).toBe(true);
    // Let the losing promises reject now; vitest fails the run on an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80));
  });
  it("#358: the second end() of a span is logged as a duplicate drop, not silently discarded", async () => {
    const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const em = new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only", log: (message, meta) => logs.push({ message, meta }) });
    const span = em.startSpan({ ...base, type: "agent_service.run.started", name: "service" });
    expect(span.end("ok", { type: "agent_service.run.completed" })).not.toBeNull();
    expect(span.end("error", { type: "agent_service.run.failed" })).toBeNull();
    await em.flush();
    const drops = logs.filter((l) => l.message === "duplicate_dropped");
    expect(drops).toHaveLength(1);
    expect(drops[0]!.meta.spanId).toBe(span.spanId);
  });
  it("#358: reseeding from the store index after a restart keeps the trace sequence monotonic (index.ts wiring)", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    em.emit(base);
    em.emit({ ...base, spanId: "spn_2" });
    await em.flush();
    // Same loop index.ts runs on boot: seed every trace from the rebuilt store index.
    const restarted = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    for (const entry of store.listRuns()) restarted.seedSequence(entry.traceId, entry.lastSequence);
    expect(restarted.emit(base)!.sequence).toBe(2);
  });
  it("#367: a straggler emitted after rollup+evictRun continues the stored sequence and serves last", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    em.emit(base); // seq 0
    em.emit({ ...base, spanId: "spn_2", type: "run.timed_out", status: "timeout" }); // seq 1 — terminal, rollup runs on it
    await em.flush();
    em.evictRun("run-1"); // index.ts evicts after the rollup; the eval post_check has not emitted yet
    const straggler = em.emit({ ...base, spanId: "spn_3", type: "runtime.postcheck.failed", category: "runtime", name: "post-check", status: "error" })!;
    expect(straggler.sequence).toBe(2); // continues from the store index, not 0
    await em.flush();
    const stored = await store.readRun("run-1");
    expect(stored.map((e) => e.sequence)).toEqual([0, 1, 2]);
    // The served timeline sorts sequence-first: the straggler stays last, not pinned at the top.
    const view = buildTrace(stored, { capturePolicy: "metadata_only" });
    expect(view.events.at(-1)!.spanId).toBe("spn_3");
  });
  it("keeps processing the queue after a rejected append", async () => {
    const inner = new MemoryTraceStore();
    let first = true;
    const store: TraceStore = {
      initialize: () => inner.initialize(),
      append: (event) => { if (first) { first = false; return Promise.reject(new Error("boom")); } return inner.append(event); },
      readRun: (runId) => inner.readRun(runId),
      runIdForTrace: (traceId) => inner.runIdForTrace(traceId),
      listRuns: () => inner.listRuns(),
      markTruncated: (runId) => inner.markTruncated(runId),
    };
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    em.emit(base);
    em.emit({ ...base, spanId: "spn_2" });
    await em.flush();
    const stored = await store.readRun("run-1");
    expect(stored.some((e) => e.spanId === "spn_2")).toBe(true);
  });
});
