import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";
import { ALWAYS_KEEP_TYPES, MemoryTraceStore, NdjsonTraceStore, TRACE_CAPS, shrinkToCap } from "./store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function tmp(): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), "glassbox-store-")); dirs.push(d); return d; }

const ev = (sequence: number, over: Partial<ObservationEvent> = {}): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + sequence, sequence, traceId: "trc_1", spanId: "spn_" + sequence,
  runId: "run-1", agentId: "agt-1", actorId: "local-user", actorType: "human", attempt: 1,
  timestamp: new Date(1_700_000_000_000 + sequence).toISOString(), type: "tool.call.completed", category: "tool",
  phase: "instant", status: "ok", name: "t" + sequence, source: { component: "AgentRunner", observed: true },
  attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});

describe.each([
  ["NdjsonTraceStore", async () => new NdjsonTraceStore(path.join(await tmp(), "traces"))],
  ["MemoryTraceStore", async () => new MemoryTraceStore()],
])("%s", (_name, make) => {
  it("appends, reads in sequence order, and ignores duplicate eventIds", async () => {
    const store = await make(); await store.initialize();
    expect(await store.append(ev(2))).toEqual({ stored: true });
    expect(await store.append(ev(1))).toEqual({ stored: true });
    expect(await store.append(ev(2))).toEqual({ stored: false, reason: "duplicate" });
    const events = await store.readRun("run-1");
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(store.listRuns()[0]).toMatchObject({ runId: "run-1", traceId: "trc_1", eventCount: 2, lastSequence: 2, truncated: false });
    expect(store.runIdForTrace("trc_1")).toBe("run-1");
  });
  it("enforces the per-run event cap but always keeps terminal/error events", async () => {
    const store = await make(); await store.initialize();
    for (let i = 1; i <= TRACE_CAPS.maxEventsPerRun; i++) await store.append(ev(i));
    expect(await store.append(ev(9001))).toEqual({ stored: false, reason: "cap_events" });
    expect(await store.append(ev(9002, { type: "run.failed", category: "control", status: "error" }))).toEqual({ stored: true });
    expect(ALWAYS_KEEP_TYPES.has("run.failed")).toBe(true);
    expect((await store.readRun("run-1")).length).toBe(TRACE_CAPS.maxEventsPerRun + 1);
  });
});

describe("NdjsonTraceStore persistence", () => {
  it("rebuilds the index from files on initialize and dedups duplicates in the file", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize();
    await a.append(ev(1)); await a.append(ev(2));
    // simulate a duplicate line written by a crash/retry
    const file = path.join(dir, "run-1.ndjson");
    await writeFile(file, (await readFile(file, "utf8")) + JSON.stringify(ev(2)) + "\n");
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect((await b.readRun("run-1")).length).toBe(2);
    expect(b.listRuns()).toEqual(a.listRuns());
  });
  it("ignores a corrupt line without losing the rest", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize(); await a.append(ev(1));
    await writeFile(path.join(dir, "run-1.ndjson"), (await readFile(path.join(dir, "run-1.ndjson"), "utf8")) + "{not json\n");
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect((await b.readRun("run-1")).length).toBe(1);
  });
  it("append p95 stays under 20ms for 100 events", async () => {
    const store = new NdjsonTraceStore(path.join(await tmp(), "traces")); await store.initialize();
    const times: number[] = [];
    for (let i = 1; i <= 100; i++) { const t = performance.now(); await store.append(ev(i)); times.push(performance.now() - t); }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(20);
  });
});

describe("shrinkToCap", () => {
  it("strips attributes and summary when serialized size exceeds 32KB", () => {
    const big = ev(1, { attributes: { blob: "x".repeat(2000) }, summary: { text: "y".repeat(4096), policy: "safe_summary" } });
    const many: Record<string, string> = {}; for (let i = 0; i < 40; i++) many["k" + i] = "v".repeat(1000);
    const huge = { ...big, attributes: many };
    const out = shrinkToCap(huge);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(TRACE_CAPS.maxEventBytes);
    expect(out.attributes).toEqual({});
    expect(out.privacy.reason).toBe("event_truncated");
    expect(shrinkToCap(ev(2))).toEqual(ev(2));
  });
});
