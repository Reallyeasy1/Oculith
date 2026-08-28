import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { JsonEvaluationStore } from "./evaluation.js";
import { buildTrace } from "./query.js";
import { SCHEMA_VERSION } from "./schema.js";
import { JsonRunSummaryStore, summaryFromView, type RunSummary } from "./summary.js";
import { computeMetric, METRIC_CATALOGUE, MetricStore, metricQueryBody, percentile, type MetricQuery } from "./metrics.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

// updatedAt is pinned so a startedAt-less row has a deterministic sort key (the store orders by startedAt ?? updatedAt).
const stub = (over: Partial<RunSummary>): RunSummary => ({
  ...summaryFromView(buildTrace([], { capturePolicy: "metadata_only" })),
  runId: "r", traceId: "t", agentId: "agt-1", executionStatus: "completed", eventCount: 1, updatedAt: "2026-08-01T00:00:00.000Z", ...over,
});
const row = (runId: string, configHash: string | undefined, startedAt: string | undefined, executionStatus: RunSummary["executionStatus"],
  toolCalls: number, toolFailures: number, tokens: { input: number; output: number } | undefined, durationMs: number | undefined, denials: number): RunSummary => {
  const base = stub({ runId, traceId: "trc-" + runId, configHash, startedAt, executionStatus, durationMs, denials });
  return { ...base, metrics: { ...base.metrics, toolCalls, toolFailures, denials, ...(tokens ? { tokens } : {}) } };
};
const d = (day: number, time: string) => `2026-08-0${day}T${time}:00.000Z`;

// The acceptance fixture: 30 hand-written summaries across two configHashes (18 cfg-a, 11 cfg-b) plus one
// degraded row with no configHash at all. Every expectation below is computed by hand from this table.
const FIXTURE: RunSummary[] = [
  row("a01", "cfg-a", d(1, "00:10"), "completed", 4, 1, { input: 100, output: 50 }, 1000, 0),
  row("a02", "cfg-a", d(1, "00:20"), "completed", 2, 0, { input: 200, output: 100 }, 2000, 1),
  row("a03", "cfg-a", d(1, "01:05"), "completed", 6, 2, { input: 300, output: 150 }, 3000, 0),
  row("a04", "cfg-a", d(1, "02:00"), "failed", 3, 3, { input: 400, output: 200 }, 4000, 2),
  row("a05", "cfg-a", d(1, "02:30"), "completed", 0, 0, undefined, 5000, 0),
  row("a06", "cfg-a", d(2, "00:00"), "completed", 5, 0, { input: 500, output: 250 }, 6000, 0),
  row("a07", "cfg-a", d(2, "00:30"), "timeout", 1, 1, undefined, undefined, 0),
  row("a08", "cfg-a", d(2, "01:00"), "completed", 8, 2, { input: 150, output: 75 }, 7000, 1),
  row("a09", "cfg-a", d(2, "03:00"), "cancelled", 0, 0, { input: 50, output: 25 }, 8000, 0),
  row("a10", "cfg-a", d(2, "04:00"), "completed", 10, 0, { input: 250, output: 125 }, 9000, 0),
  row("a11", "cfg-a", d(3, "00:00"), "running", 0, 0, undefined, undefined, 0),
  row("a12", "cfg-a", d(3, "00:10"), "completed", 7, 1, { input: 350, output: 175 }, 10000, 3),
  row("a13", "cfg-a", d(3, "01:00"), "failed", 2, 2, { input: 450, output: 225 }, 11000, 0),
  row("a14", "cfg-a", d(3, "02:00"), "completed", 9, 0, { input: 550, output: 275 }, 12000, 0),
  row("a15", "cfg-a", d(3, "02:30"), "completed", 3, 0, { input: 650, output: 325 }, 13000, 1),
  row("a16", "cfg-a", d(3, "03:00"), "completed", 4, 0, undefined, 14000, 0),
  row("a17", "cfg-a", d(3, "04:00"), "running", 1, 0, { input: 750, output: 375 }, undefined, 0),
  row("a18", "cfg-a", undefined, "completed", 5, 1, { input: 850, output: 425 }, 15000, 0),
  row("b01", "cfg-b", d(2, "05:00"), "completed", 2, 1, { input: 10, output: 5 }, 100, 0),
  row("b02", "cfg-b", d(2, "06:00"), "completed", 2, 1, { input: 20, output: 10 }, 200, 0),
  row("b03", "cfg-b", d(2, "07:00"), "failed", 2, 1, { input: 30, output: 15 }, 300, 1),
  row("b04", "cfg-b", d(2, "08:00"), "completed", 4, 0, { input: 40, output: 20 }, 400, 0),
  row("b05", "cfg-b", d(3, "05:00"), "completed", 4, 0, { input: 50, output: 25 }, 500, 0),
  row("b06", "cfg-b", d(3, "06:00"), "failed", 4, 2, { input: 60, output: 30 }, 600, 0),
  row("b07", "cfg-b", d(3, "07:00"), "completed", 6, 0, { input: 70, output: 35 }, 700, 2),
  row("b08", "cfg-b", d(3, "08:00"), "completed", 6, 0, { input: 80, output: 40 }, 800, 0),
  row("b09", "cfg-b", d(3, "09:00"), "timeout", 6, 3, { input: 90, output: 45 }, 900, 0),
  row("b10", "cfg-b", d(3, "10:00"), "completed", 8, 0, { input: 100, output: 50 }, 1000, 0),
  row("b11", "cfg-b", d(3, "11:00"), "completed", 8, 4, { input: 110, output: 55 }, 1100, 1),
  row("x01", undefined, d(1, "12:00"), "completed", 1, 0, { input: 5, output: 5 }, 50, 0),
];

const q = (input: Record<string, unknown>): MetricQuery => metricQueryBody.parse(input);
const scalar = (metric: string, type: string, filter?: Record<string, unknown>, extra?: Record<string, unknown>) =>
  computeMetric(q({ metric, aggregation: { type }, ...(filter ? { filter } : {}), ...(extra ?? {}) }), FIXTURE);

describe("metricQueryBody", () => {
  it("rejects an unknown metric with a message listing the whole catalogue", () => {
    const parsed = metricQueryBody.safeParse({ metric: "nope", aggregation: { type: "count" } });
    expect(parsed.success).toBe(false);
    const message = JSON.stringify(parsed.error?.issues);
    for (const name of Object.keys(METRIC_CATALOGUE)) expect(message).toContain(name);
  });

  it("rejects aggregations outside the metric's row of the matrix, naming the valid ones", () => {
    for (const [metric, aggregation, valid] of [
      ["denials", "p95", "count, avg"], ["latency", "rate", "avg, p50, p95"], ["task_completion", "avg", "rate"], ["tool_failure_rate", "count", "rate"],
    ] as const) {
      const parsed = metricQueryBody.safeParse({ metric, aggregation: { type: aggregation }, ...(metric === "task_completion" ? { evaluator: { id: "task_completion" } } : {}) });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(valid);
    }
    // series is not a loophole: the wrapped statistic must be valid for the metric too
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "series", bucket: "day", statistic: "rate" } }).success).toBe(false);
  });

  it("requires evaluator for task_completion and rejects stray parameters elsewhere", () => {
    expect(metricQueryBody.safeParse({ metric: "task_completion", aggregation: { type: "rate" } }).success).toBe(false);
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "p95" }, evaluator: { id: "task_completion" } }).success).toBe(false);
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "p95" }, tokens: { field: "input" } }).success).toBe(false);
    expect(metricQueryBody.safeParse({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "task_completion", version: 1 } }).success).toBe(true);
    expect(metricQueryBody.safeParse({ metric: "tokens", aggregation: { type: "avg" }, tokens: { field: "input" } }).success).toBe(true);
  });

  it("rejects a range that mixes lastRuns with a time window", () => {
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "avg" }, range: { lastRuns: 5, from: d(1, "00:00") } }).success).toBe(false);
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "avg" }, range: { lastRuns: 5 } }).success).toBe(true);
    expect(metricQueryBody.safeParse({ metric: "latency", aggregation: { type: "avg" }, range: { from: d(1, "00:00"), to: d(2, "00:00") } }).success).toBe(true);
  });
});

describe("percentile (nearest-rank)", () => {
  it("returns an observed value, never an interpolated one", () => {
    // Linear interpolation would give p95 = 880 here; nearest-rank must return the real observation.
    expect(percentile([100, 200, 300, 400, 1000], 0.95)).toBe(1000);
    expect(percentile([100, 200, 300, 400, 1000], 0.5)).toBe(300);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBeNull();
  });
});

describe("computeMetric on the 30-summary fixture", () => {
  it("computes every telemetry metric x aggregation cell for cfg-a by hand", () => {
    // 18 runs; 16 terminal (a11, a17 running); 12 completed
    expect(scalar("execution_completion", "rate", { configHash: "cfg-a" })).toMatchObject({ kind: "telemetry", value: 12 / 16, provenance: { count: 18, sampled: 16 } });
    expect(scalar("execution_completion", "count", { configHash: "cfg-a" }).value).toBe(12);
    // sum failures 13 / sum calls 70; 15 runs made at least one call
    expect(scalar("tool_failure_rate", "rate", { configHash: "cfg-a" })).toMatchObject({ value: 13 / 70, provenance: { count: 18, sampled: 15 } });
    // calls sorted: [0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10]
    expect(scalar("tool_calls", "count", { configHash: "cfg-a" }).value).toBe(70);
    expect(scalar("tool_calls", "avg", { configHash: "cfg-a" }).value).toBe(70 / 18);
    expect(scalar("tool_calls", "p50", { configHash: "cfg-a" }).value).toBe(3);
    expect(scalar("tool_calls", "p95", { configHash: "cfg-a" }).value).toBe(10);
    // failures per run sorted: [0×10, 1×4, 2×3, 3] — sum 13, every row carries the field (#213)
    expect(scalar("tool_failures", "count", { configHash: "cfg-a" })).toMatchObject({ value: 13, provenance: { count: 18, sampled: 18 } });
    expect(scalar("tool_failures", "avg", { configHash: "cfg-a" }).value).toBe(13 / 18);
    expect(scalar("tool_failures", "p50", { configHash: "cfg-a" }).value).toBe(0);
    expect(scalar("tool_failures", "p95", { configHash: "cfg-a" }).value).toBe(3);
    // 14 rows carry tokens (a05, a07, a11, a16 do not); totals sum 8325, sorted p50 = 525, p95 = 1275
    expect(scalar("tokens", "count", { configHash: "cfg-a" })).toMatchObject({ value: 8325, provenance: { count: 18, sampled: 14 } });
    expect(scalar("tokens", "avg", { configHash: "cfg-a" }).value).toBe(8325 / 14);
    expect(scalar("tokens", "p50", { configHash: "cfg-a" }).value).toBe(525);
    expect(scalar("tokens", "p95", { configHash: "cfg-a" }).value).toBe(1275);
    expect(scalar("tokens", "p95", { configHash: "cfg-a" }, { tokens: { field: "input" } }).value).toBe(850);
    expect(scalar("tokens", "count", { configHash: "cfg-a" }, { tokens: { field: "output" } }).value).toBe(2775);
    // 15 rows carry durationMs (a07, a11, a17 do not): 1000..15000
    expect(scalar("latency", "avg", { configHash: "cfg-a" })).toMatchObject({ value: 8000, provenance: { count: 18, sampled: 15 } });
    expect(scalar("latency", "p50", { configHash: "cfg-a" }).value).toBe(8000);
    expect(scalar("latency", "p95", { configHash: "cfg-a" }).value).toBe(15000);
    expect(scalar("denials", "count", { configHash: "cfg-a" }).value).toBe(8);
    expect(scalar("denials", "avg", { configHash: "cfg-a" }).value).toBe(8 / 18);
  });

  it("computes the same cells for cfg-b and for the whole set", () => {
    expect(scalar("execution_completion", "rate", { configHash: "cfg-b" })).toMatchObject({ value: 8 / 11, provenance: { count: 11, sampled: 11 } });
    expect(scalar("tool_failure_rate", "rate", { configHash: "cfg-b" }).value).toBe(12 / 52);
    expect(scalar("latency", "avg", { configHash: "cfg-b" }).value).toBe(600);
    expect(scalar("latency", "p50", { configHash: "cfg-b" }).value).toBe(600);
    expect(scalar("latency", "p95", { configHash: "cfg-b" }).value).toBe(1100);
    expect(scalar("tokens", "count", { configHash: "cfg-b" }).value).toBe(990);
    expect(scalar("denials", "count", { configHash: "cfg-b" }).value).toBe(4);
    // whole set: 30 runs, 28 terminal, 21 completed
    expect(scalar("execution_completion", "rate")).toMatchObject({ value: 21 / 28, provenance: { count: 30, sampled: 28 } });
  });

  it("buckets series by UTC day and hour, wrapping the requested scalar statistic", () => {
    const day = computeMetric(q({ metric: "latency", aggregation: { type: "series", bucket: "day", statistic: "avg" }, filter: { configHash: "cfg-b" } }), FIXTURE);
    expect(day.value).toEqual([
      { bucket: "2026-08-02T00:00:00.000Z", value: 250, count: 4, sampled: 4 },
      { bucket: "2026-08-03T00:00:00.000Z", value: 800, count: 7, sampled: 7 },
    ]);
    expect(day.provenance).toMatchObject({ count: 11, sampled: 11 });
    const rate = computeMetric(q({ metric: "execution_completion", aggregation: { type: "series", bucket: "day", statistic: "rate" }, filter: { configHash: "cfg-b" } }), FIXTURE);
    expect(rate.value).toEqual([
      { bucket: "2026-08-02T00:00:00.000Z", value: 3 / 4, count: 4, sampled: 4 },
      { bucket: "2026-08-03T00:00:00.000Z", value: 5 / 7, count: 7, sampled: 7 },
    ]);
    const failures = computeMetric(q({ metric: "tool_failure_rate", aggregation: { type: "series", bucket: "day", statistic: "rate" }, filter: { configHash: "cfg-b" } }), FIXTURE);
    expect(failures.value).toEqual([
      { bucket: "2026-08-02T00:00:00.000Z", value: 3 / 10, count: 4, sampled: 4 },
      { bucket: "2026-08-03T00:00:00.000Z", value: 9 / 42, count: 7, sampled: 7 },
    ]);
    const hours = computeMetric(q({ metric: "tool_calls", aggregation: { type: "series", bucket: "hour", statistic: "avg" }, filter: { configHash: "cfg-b", from: d(2, "00:00"), to: d(2, "23:59") } }), FIXTURE);
    expect(hours.value).toEqual([
      { bucket: "2026-08-02T05:00:00.000Z", value: 2, count: 1, sampled: 1 },
      { bucket: "2026-08-02T06:00:00.000Z", value: 2, count: 1, sampled: 1 },
      { bucket: "2026-08-02T07:00:00.000Z", value: 2, count: 1, sampled: 1 },
      { bucket: "2026-08-02T08:00:00.000Z", value: 4, count: 1, sampled: 1 },
    ]);
    // a run with no startedAt cannot be placed in a bucket: cfg-a day series covers 17 of 18 runs
    const gaps = computeMetric(q({ metric: "tokens", aggregation: { type: "series", bucket: "day", statistic: "count" }, filter: { configHash: "cfg-a" } }), FIXTURE);
    expect((gaps.value as { bucket: string }[]).map((p) => p.bucket)).toEqual(["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"]);
    expect(gaps.provenance.count).toBe(18);
  });

  it("windows with lastRuns (newest startedAt first) and intersects range with filter times", () => {
    const last = computeMetric(q({ metric: "latency", aggregation: { type: "avg" }, filter: { configHash: "cfg-a" }, range: { lastRuns: 5 } }), FIXTURE);
    expect(last.value).toBe(12500); // a17 (no durationMs), a16, a15, a14, a13 → (14000+13000+12000+11000)/4
    expect(last.provenance).toMatchObject({ count: 5, sampled: 4, runIds: ["a17", "a16", "a15", "a14", "a13"], filter: { configHash: "cfg-a", lastRuns: 5 } });
    const both = computeMetric(q({ metric: "tool_calls", aggregation: { type: "count" }, filter: { configHash: "cfg-a", from: d(2, "00:00") }, range: { from: d(1, "00:00"), to: d(2, "01:00") } }), FIXTURE);
    expect(both.value).toBe(14); // effective window [d2T00:00, d2T01:00] → a06 + a07 + a08
    expect(both.provenance).toMatchObject({ count: 3, filter: { configHash: "cfg-a", from: d(2, "00:00"), to: d(2, "01:00") } });
    // same store semantics as RunSummaryStore.query: a from-filter also excludes rows without startedAt
    expect(scalar("execution_completion", "rate", { configHash: "cfg-a", from: d(1, "00:00") }).provenance.count).toBe(17);
    // second-precision bounds are normalised to milliseconds, so a `from` naming a Run's exact start keeps it
    const exact = scalar("latency", "avg", { configHash: "cfg-a", from: "2026-08-01T00:10:00Z" });
    expect(exact.provenance.count).toBe(17);
    expect(exact.provenance.runIds).toContain("a01");
    expect(exact.provenance.filter.from).toBe(d(1, "00:10"));
  });

  it("never reports a half-observed token pair as a total", () => {
    const base = row("half", "cfg-h", d(1, "00:00"), "completed", 1, 0, undefined, 100, 0);
    const half = { ...base, metrics: { ...base.metrics, tokens: { input: 500 } } };
    const whole = row("whole", "cfg-h", d(1, "01:00"), "completed", 1, 0, { input: 10, output: 20 }, 100, 0);
    const total = computeMetric(q({ metric: "tokens", aggregation: { type: "count" } }), [half, whole]);
    expect(total.value).toBe(30);
    expect(total.provenance).toMatchObject({ count: 2, sampled: 1 });
    // the observed side is still reachable through its own field
    expect(computeMetric(q({ metric: "tokens", aggregation: { type: "count" }, tokens: { field: "input" } }), [half, whole]).value).toBe(510);
  });

  it("keeps a degraded summary without configHash out of configHash-filtered aggregates, visibly", () => {
    expect(scalar("denials", "count").provenance.count).toBe(30); // x01 counted when unfiltered
    expect(scalar("denials", "count", { configHash: "cfg-a" }).provenance.runIds).not.toContain("x01");
    expect((scalar("denials", "count").provenance.runIds ?? [])).toContain("x01");
  });

  it("answers an empty window with null, never a fabricated zero", () => {
    const empty = scalar("latency", "p95", { agentId: "no-such-agent" });
    expect(empty.value).toBeNull();
    expect(empty.provenance).toMatchObject({ count: 0, sampled: 0, runIds: [] });
    expect(scalar("tool_failure_rate", "rate", { executionStatus: "cancelled" }).value).toBeNull(); // a09/b-none: zero tool calls
  });

  it("inlines runIds only up to the cap; beyond it the filter echo is the drill-back contract", () => {
    const big = Array.from({ length: 120 }, (_, i) => row(`big-${String(i).padStart(3, "0")}`, "cfg-big", d(1, "00:00"), "completed", 1, 0, undefined, 100, 0));
    const capped = computeMetric(q({ metric: "tool_calls", aggregation: { type: "count" } }), big);
    expect(capped.provenance.count).toBe(120);
    expect(capped.provenance.runIds).toBeUndefined();
    expect(capped.provenance.filter).toEqual({});
  });
});

async function evalSetup() {
  const dir = await mkdtemp(path.join(tmpdir(), "metric-store-"));
  dirs.push(dir);
  const json = new JsonStore(path.join(dir, "db.json"));
  await json.initialize();
  const summaries = new JsonRunSummaryStore(json);
  const evaluations = new JsonEvaluationStore(json, summaries);
  await evaluations.initialize();
  return { json, summaries, evaluations, metrics: new MetricStore(summaries, evaluations) };
}

describe("MetricStore", () => {
  it("agrees with the pure computeMetric for telemetry metrics on either path", async () => {
    const { summaries, metrics } = await evalSetup();
    for (const summary of FIXTURE) await summaries.upsert(summary);
    for (const input of [
      { metric: "latency", aggregation: { type: "p95" }, filter: { configHash: "cfg-a" } },
      { metric: "execution_completion", aggregation: { type: "rate" }, filter: { configHash: "cfg-b" } },
      { metric: "latency", aggregation: { type: "avg" }, filter: { configHash: "cfg-a" }, range: { lastRuns: 5 } },
    ]) {
      expect(await metrics.query(q(input))).toEqual(computeMetric(q(input), FIXTURE));
    }
  });

  it("computes task_completion from results: excludes unevaluated Runs and reports how many were evaluated", async () => {
    const { summaries, evaluations, metrics } = await evalSetup();
    for (let i = 1; i <= 10; i += 1) {
      await summaries.upsert(stub({ runId: `r${i}`, traceId: `trc-r${i}`, startedAt: d(i <= 5 ? 1 : 2, `0${i % 5}:00`), executionStatus: "completed" }));
    }
    const put = (runId: string, version: number, passed: boolean, evaluatedAt: string) => evaluations.putResult({
      runId, evaluatorId: "task_completion", evaluatorVersion: version, score: passed ? 5 : 2, passed,
      explanation: passed ? "done" : "not done", evidenceEventIds: [], metadata: {}, evaluatedAt,
    });
    // r1 is re-evaluated: only its latest verdict may count (the store keeps history but exposes the current result)
    await put("r1", 1, false, d(3, "00:00"));
    for (const [runId, passed] of [["r1", true], ["r2", true], ["r3", true], ["r4", true], ["r5", false], ["r6", false]] as const) await put(runId, 1, passed, d(3, "01:00"));
    const v2 = await evaluations.createDefinition({ id: "task_completion", name: "Task Completion", type: "llm_judge", rubric: "Stricter rubric.", minScore: 1, maxScore: 5, passThreshold: 4, config: {}, setsTaskOutcome: true });
    expect(v2.version).toBe(2);
    await put("r7", 2, true, d(3, "02:00"));
    await put("r8", 2, false, d(3, "02:00"));

    const v1rate = await metrics.query(q({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "task_completion", version: 1 } }));
    expect(v1rate).toMatchObject({ kind: "evaluation", value: 4 / 6, provenance: { count: 10, sampled: 6, evaluated: 6, evaluatorId: "task_completion", version: 1 } });
    // version omitted resolves to the latest definition and echoes what it resolved
    const latest = await metrics.query(q({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "task_completion" } }));
    expect(latest).toMatchObject({ value: 1 / 2, provenance: { evaluated: 2, version: 2 } });
    // day series: r1..r5 started day 1 (4 of 5 passed at v1), r6..r10 day 2 (only r6 evaluated, failed)
    const series = await metrics.query(q({ metric: "task_completion", aggregation: { type: "series", bucket: "day", statistic: "rate" }, evaluator: { id: "task_completion", version: 1 } }));
    expect(series.value).toEqual([
      { bucket: "2026-08-01T00:00:00.000Z", value: 4 / 5, count: 5, sampled: 5 },
      { bucket: "2026-08-02T00:00:00.000Z", value: 0, count: 5, sampled: 1 },
    ]);
    // telemetry and evaluation planes are labelled and never folded into one number
    expect((await metrics.query(q({ metric: "execution_completion", aggregation: { type: "rate" } }))).kind).toBe("telemetry");
    await expect(metrics.query(q({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "no-such-evaluator" } }))).rejects.toThrow("no-such-evaluator");
    await expect(metrics.query(q({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "task_completion", version: 9 } }))).rejects.toThrow("@9");
  });

  it("answers every worst-case query over 1,000 summaries well under the 500 ms bound (PRD FR-23)", async () => {
    const { json, metrics } = await evalSetup();
    const statuses: RunSummary["executionStatus"][] = ["completed", "completed", "completed", "failed", "timeout"];
    const rows = Array.from({ length: 1_000 }, (_, i) => row(
      `perf-${String(i).padStart(4, "0")}`, i % 2 ? "cfg-a" : "cfg-b",
      `2026-08-${String(1 + (i % 20)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      statuses[i % 5] ?? "completed", i % 12, i % 3, { input: i, output: i * 2 }, 50 + i, i % 4,
    ));
    const results = rows.filter((_, i) => i % 3 === 0).map((summary, i) => ({
      runId: summary.runId, evaluatorId: "task_completion", evaluatorVersion: 1, score: i % 2 ? 5 : 2, passed: i % 2 === 1,
      explanation: "seeded", evidenceEventIds: [], metadata: {}, evaluatedAt: d(3, "00:00"),
    }));
    await json.mutate((db) => { db.runSummaries.push(...rows); db.evaluationResults.push(...results); });
    for (const input of [
      { metric: "latency", aggregation: { type: "series", bucket: "day", statistic: "p95" } },
      { metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "task_completion", version: 1 } },
      { metric: "tool_failure_rate", aggregation: { type: "rate" }, filter: { configHash: "cfg-a" } },
    ]) {
      const startedAt = performance.now();
      const result = await metrics.query(q(input));
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.provenance.runIds).toBeUndefined(); // 1,000-run windows never inline ids
    }
  });
});
