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
    expect(store.listRuns()[0]).toMatchObject({ runId: "run-1", truncated: true }); // visible before trace.truncated lands
    expect(await store.append(ev(9002, { type: "run.failed", category: "control", status: "error" }))).toEqual({ stored: true });
    expect(ALWAYS_KEEP_TYPES.has("run.failed")).toBe(true);
    expect((await store.readRun("run-1")).length).toBe(TRACE_CAPS.maxEventsPerRun + 1);
    // 1000 real appendFile round-trips: durable-per-event is the design (AC-06 restart depends on it),
    // so this is I/O-bound and needs more than vitest's 5 s default under a loaded suite.
  }, 30_000);
  it("serialises concurrent appends to one run so the events cap can't be exceeded", async () => {
    const store = await make(); await store.initialize();
    const results = await Promise.all(
      Array.from({ length: TRACE_CAPS.maxEventsPerRun + 5 }, (_, i) => store.append(ev(i + 1))),
    );
    const stored = results.filter((r) => r.stored);
    const capped = results.filter((r) => !r.stored);
    expect(stored.length).toBe(TRACE_CAPS.maxEventsPerRun);
    expect(capped).toEqual(Array.from({ length: 5 }, () => ({ stored: false, reason: "cap_events" })));
    expect((await store.readRun("run-1")).length).toBe(TRACE_CAPS.maxEventsPerRun);
  }, 30_000);
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
  it("ignores a corrupt line without losing the rest, and reports it instead of dropping it silently", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize(); await a.append(ev(1));
    await writeFile(path.join(dir, "run-1.ndjson"), (await readFile(path.join(dir, "run-1.ndjson"), "utf8")) + "{not json\n");
    const logged: Array<[string, Record<string, unknown>]> = [];
    const b = new NdjsonTraceStore(dir, (message, meta) => logged.push([message, meta]));
    await b.initialize();
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe("trace.lines_skipped");
    expect(logged[0]![1]).toMatchObject({ skipped: 1 });
    expect(String(logged[0]![1].file)).toContain("run-1.ndjson");
    // readRun re-parses the same file on every poll; the skip is reported once per file per process.
    expect((await b.readRun("run-1")).length).toBe(1);
    expect((await b.readRun("run-1")).length).toBe(1);
    expect(logged).toHaveLength(1);
  });
  it("starts a fresh line after a partial trailing line (crash mid-write) instead of corrupting both", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize(); await a.append(ev(1));
    const file = path.join(dir, "run-1.ndjson");
    await writeFile(file, (await readFile(file, "utf8")) + JSON.stringify(ev(2)).slice(0, 40));
    const logged: Array<[string, Record<string, unknown>]> = [];
    const b = new NdjsonTraceStore(dir, (message, meta) => logged.push([message, meta]));
    await b.initialize();
    expect(logged).toEqual([["trace.lines_skipped", expect.objectContaining({ skipped: 1 })]]);
    expect(await b.append(ev(3))).toEqual({ stored: true });
    expect((await b.readRun("run-1")).map((e) => e.sequence)).toEqual([1, 3]);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
  });
  it("restores the truncated flag on rebuild", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize();
    await a.append(ev(1));
    await a.append(ev(2, { type: "trace.truncated", category: "control" }));
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect(b.listRuns()[0]).toMatchObject({ runId: "run-1", truncated: true });
  });
  it("filters readRun by runId even if sanitized filenames collide", async () => {
    const dir = path.join(await tmp(), "traces");
    const store = new NdjsonTraceStore(dir); await store.initialize();
    // "run:1" and "run/1" both sanitize to the same "run_1.ndjson" file
    await store.append(ev(1, { runId: "run:1", traceId: "trc_a" }));
    await store.append(ev(1, { runId: "run/1", traceId: "trc_b" }));
    const events = await store.readRun("run:1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "run:1", traceId: "trc_a" });
  });
  it("append p95 stays under 200ms for 100 events", async () => {
    // Regression guard against an O(n) or fsync-per-event regression, not a latency SLO: the
    // threshold is deliberately loose so a loaded parallel suite on a slow disk can't turn it red.
    const store = new NdjsonTraceStore(path.join(await tmp(), "traces")); await store.initialize();
    const times: number[] = [];
    for (let i = 1; i <= 100; i++) { const t = performance.now(); await store.append(ev(i)); times.push(performance.now() - t); }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(200);
  });
});

describe("per-run byte cap and markTruncated", () => {
  it("enforces the per-run byte cap but always keeps terminal/error events", async () => {
    // MemoryTraceStore: the cap logic is shared with NdjsonTraceStore, and pushing 10MB
    // of ~30KB events through real disk I/O would make this test needlessly slow.
    const store = new MemoryTraceStore(); await store.initialize();
    const attributes = { blob: "x".repeat(30_000) };
    let i = 1;
    for (; i <= TRACE_CAPS.maxEventsPerRun; i++) {
      await store.append(ev(i, { attributes }));
      if (store.listRuns()[0]!.bytes >= TRACE_CAPS.maxRunBytes) break;
    }
    const overflow = await store.append(ev(i + 1, { attributes }));
    expect(overflow).toEqual({ stored: false, reason: "cap_bytes" });
    expect(store.listRuns()[0]!.truncated).toBe(true);
    const kept = await store.append(ev(i + 2, { type: "run.failed", category: "control", status: "error" }));
    expect(kept).toEqual({ stored: true });
  });
  it("markTruncated flags the run in the index", async () => {
    const store = new MemoryTraceStore(); await store.initialize();
    await store.append(ev(1));
    store.markTruncated("run-1");
    expect(store.listRuns()[0]).toMatchObject({ runId: "run-1", truncated: true });
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

describe("NdjsonTraceStore.cleanup (retention, FR-14)", () => {
  const DAY = 86_400_000;
  const T0 = 1_700_000_000_000;
  const at = (daysAgo: number, seq: number) => new Date(T0 - daysAgo * DAY + seq).toISOString();
  const now = new Date(T0);
  /** A finished run with `n` content events + run.completed, last event `daysAgo` days before `now`. */
  async function seedRun(store: NdjsonTraceStore, runId: string, daysAgo: number, n = 3, attributes: ObservationEvent["attributes"] = {}) {
    const base = { runId, traceId: "trc_" + runId };
    for (let i = 1; i <= n; i++) await store.append(ev(i, { ...base, attributes, timestamp: at(daysAgo, i) }));
    await store.append(ev(n + 1, { ...base, type: "run.completed", category: "control", status: "ok", timestamp: at(daysAgo, n + 1) }));
  }

  it("age: compacts runs whose last event is older than the window to terminal events + trace.truncated", async () => {
    const dir = path.join(await tmp(), "traces");
    const store = new NdjsonTraceStore(dir); await store.initialize();
    await seedRun(store, "old", 10); await seedRun(store, "young", 1);
    const report = await store.cleanup({ retentionDays: 7, maxDiskMb: 0, now });
    expect(report.evicted).toEqual([expect.objectContaining({ runId: "old", traceId: "trc_old", status: "ok", reason: "retention_age" })]);
    const kept = await store.readRun("old");
    expect(kept.map((e) => e.type)).toEqual(["run.completed", "trace.truncated"]);
    expect(kept[1]).toMatchObject({ attributes: { reason: "retention_age", droppedEvents: 3 }, sequence: 5, status: "unset" });
    expect(store.listRuns().find((r) => r.runId === "old")).toMatchObject({ evicted: true, truncated: true, status: "ok", eventCount: 2 });
    expect(store.listRuns().find((r) => r.runId === "young")).toMatchObject({ evicted: false, truncated: false, status: "ok", eventCount: 4 });
    expect((await store.readRun("young")).length).toBe(4);
  });

  it("disk cap: evicts oldest completed runs first until total bytes are under the cap", async () => {
    const dir = path.join(await tmp(), "traces");
    const store = new NdjsonTraceStore(dir); await store.initialize();
    const blob = { blob: "x".repeat(3000) };
    await seedRun(store, "b", 2, 4, blob); await seedRun(store, "c", 1, 4, blob); await seedRun(store, "a", 3, 4, blob);
    const before = store.listRuns().reduce((n, e) => n + e.bytes, 0);
    expect(before).toBeGreaterThan(30_000);
    const report = await store.cleanup({ retentionDays: 0, maxDiskMb: 0.02, now });
    expect(report.evicted.map((e) => [e.runId, e.reason])).toEqual([["a", "retention_disk"], ["b", "retention_disk"]]);
    expect(report.bytesBefore).toBe(before);
    expect(report.bytesAfter).toBeLessThanOrEqual(0.02 * 1024 * 1024);
    expect(store.listRuns().find((r) => r.runId === "c")).toMatchObject({ evicted: false, eventCount: 5 });
  });

  it("never evicts a run without terminal evidence (still running), even under pressure", async () => {
    const dir = path.join(await tmp(), "traces");
    const store = new NdjsonTraceStore(dir); await store.initialize();
    for (let i = 1; i <= 3; i++) await store.append(ev(i, { runId: "live", traceId: "trc_live", timestamp: at(30, i), attributes: { blob: "x".repeat(3000) } }));
    const report = await store.cleanup({ retentionDays: 1, maxDiskMb: 0.001, now });
    expect(report.evicted).toEqual([]);
    expect(store.listRuns()[0]).toMatchObject({ runId: "live", status: "running", evicted: false, eventCount: 3 });
  });

  it("tombstone survives a restart and is never re-evicted", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize();
    await seedRun(a, "old", 10, 3);
    await a.cleanup({ retentionDays: 7, maxDiskMb: 0, now });
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect(b.listRuns()).toEqual(a.listRuns());
    expect(b.listRuns()[0]).toMatchObject({ runId: "old", evicted: true, truncated: true, status: "ok", eventCount: 2, lastSequence: 5 });
    const again = await b.cleanup({ retentionDays: 0, maxDiskMb: 0.0001, now });
    expect(again.evicted).toEqual([]);
  });

  it("disabled knobs (0) do nothing", async () => {
    const dir = path.join(await tmp(), "traces");
    const store = new NdjsonTraceStore(dir); await store.initialize();
    await seedRun(store, "old", 365, 3, { blob: "x".repeat(3000) });
    const raw = await readFile(path.join(dir, "old.ndjson"), "utf8");
    const report = await store.cleanup({ retentionDays: 0, maxDiskMb: 0, now });
    expect(report).toMatchObject({ runs: 1, evicted: [] });
    expect(report.bytesAfter).toBe(report.bytesBefore);
    expect(await readFile(path.join(dir, "old.ndjson"), "utf8")).toBe(raw);
  });
});
