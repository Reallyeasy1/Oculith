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
  it("returns synchronously even if the store hangs, and never throws when the store rejects", async () => {
    let calls = 0;
    const slow: TraceStore = { async initialize() {}, async append() { calls++; await new Promise((r) => setTimeout(r, 200)); return { stored: true }; }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const em = new ObservationEmitter({ store: slow, capturePolicy: "metadata_only" });
    const t = performance.now(); em.emit(base); expect(performance.now() - t).toBeLessThan(50);
    const bad: TraceStore = { ...slow, async append() { throw new Error("EACCES"); } };
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
  it("seedSequence continues after a rebuild", () => {
    const em = createDefaultEmitter(); em.seedSequence("trc_1", 41);
    expect(em.emit(base)!.sequence).toBe(42);
  });
});
