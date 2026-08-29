import { describe, expect, it } from "vitest";
import { ObservationEmitter, createDefaultEmitter } from "./emitter.js";
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
