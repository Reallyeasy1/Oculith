// ponytail: one runnable check for the chart math behind MetricsDashboard (#342). Run from repo root:
//   npx vitest run apps/web/src/charts-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { ReliabilityNumbers, ReliabilitySeriesPoint } from "./types";
import { formatDuration } from "./runs-view-model";
import { formatPercent } from "./reliability-view-model";
import type { ReliabilityDeltas } from "./types";
import {
  bucketDrillWindow,
  bucketLabel,
  bucketNoun,
  chartDeltaChips,
  domainMax,
  emptyStateMessage,
  formatCount,
  formatScore,
  hoverReadout,
  linePath,
  nearestBucketIndex,
  niceMax,
  overlayHoverReadout,
  presetWindow,
  slotIndex,
  synthesizeAxis,
  synthesizeAxisPair,
  yTicks,
} from "./charts-view-model";

const emptyNumbers: ReliabilityNumbers = {
  runs: 0,
  executionCompletionRate: null,
  taskCompletionRate: { evaluatorId: "task_completion", version: 1, evaluated: 0, passed: 0, rate: null },
  toolFailureRate: null,
  avgToolCalls: null,
  tokens: { avgInput: null, avgOutput: null, sum: null, sampled: 0 },
  latency: { p50: null, p95: null, sampled: 0 },
  denialRate: null,
  cost: { avg: null, sum: null, sampled: 0 },
};

function point(bucket: string, overrides: Partial<ReliabilityNumbers> = {}): ReliabilitySeriesPoint {
  return { bucket, judgeScores: [], ...emptyNumbers, ...overrides };
}

describe("bucketLabel", () => {
  it("formats day buckets as 'Aug 29' and hour buckets as '29 · 14:00' (UTC, matching bucket semantics)", () => {
    expect(bucketLabel("2026-08-29T00:00:00.000Z", "day")).toBe("Aug 29");
    expect(bucketLabel("2026-08-29T14:00:00.000Z", "hour")).toBe("29 · 14:00");
    expect(bucketLabel("2026-08-29T09:00:00.000Z", "hour")).toBe("29 · 09:00");
  });
});

describe("synthesizeAxis", () => {
  it("fills missing daily buckets between first and last as null points", () => {
    const axis = synthesizeAxis(
      [point("2026-08-27T00:00:00.000Z", { runs: 2 }), point("2026-08-29T00:00:00.000Z", { runs: 5 })],
      "day",
    );
    expect(axis.map((b) => b.bucket)).toEqual([
      "2026-08-27T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    ]);
    expect(axis.map((b) => b.label)).toEqual(["Aug 27", "Aug 28", "Aug 29"]);
    expect(axis.map((b) => b.point?.runs ?? null)).toEqual([2, null, 5]);
  });

  it("fills missing hourly buckets and sorts an unsorted series", () => {
    const axis = synthesizeAxis(
      [point("2026-08-29T11:00:00.000Z", { runs: 1 }), point("2026-08-29T09:00:00.000Z", { runs: 3 })],
      "hour",
    );
    expect(axis.map((b) => b.bucket)).toEqual([
      "2026-08-29T09:00:00.000Z",
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T11:00:00.000Z",
    ]);
    expect(axis[1].point).toBeNull();
  });

  it("returns [] for an empty series and skips gap fill for an absurd window", () => {
    expect(synthesizeAxis([], "day")).toEqual([]);
    const farApart = [point("2000-01-01T00:00:00.000Z"), point("2026-08-29T00:00:00.000Z")];
    expect(synthesizeAxis(farApart, "day")).toHaveLength(2);
  });
});

describe("linePath", () => {
  it("breaks at null values into separate M segments with no interpolation across the gap", () => {
    expect(linePath([0.5, null, 0.8, 0.9], 1)).toBe("M0 50 L0 50 M66.67 20 L100 10");
  });

  it("renders an isolated point as a zero-length round-cap segment", () => {
    expect(linePath([null, 0.5, null], 1)).toBe("M50 50 L50 50");
  });

  it("draws a continuous series as one segment and an all-null series as nothing", () => {
    expect(linePath([0, 1], 1)).toBe("M0 100 L100 0");
    expect(linePath([null, null], 1)).toBe("");
  });

  it("centres a single-value series and survives max 0", () => {
    expect(linePath([0.5], 1)).toBe("M50 50 L50 50");
    expect(linePath([0], 0)).toBe("M50 100 L50 100");
  });
});

describe("y domains", () => {
  it("rates use a fixed 0–1 domain: yTicks(1, formatPercent) renders 100/50/0%", () => {
    expect(yTicks(1, formatPercent)).toEqual([
      { y: 0, label: "100%" },
      { y: 50, label: "50%" },
      { y: 100, label: "0%" },
    ]);
  });

  it("niceMax pads the observed max up to a nice number, ignoring nulls", () => {
    expect(niceMax([820, null, 300])).toBe(1000);
    expect(niceMax([95])).toBe(100);
    expect(niceMax([0.4])).toBe(0.5);
  });

  it("niceMax falls back to 1 when nothing was observed", () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([null, null])).toBe(1);
    expect(niceMax([0])).toBe(1);
  });

  it("latency ticks use formatDuration labels", () => {
    expect(yTicks(1000, formatDuration).map((t) => t.label)).toEqual(["1.0 s", "500 ms", "0 ms"]);
  });

  it("#390 item 1: volume ticks label the true half value, not a rounded one (max 5 → mid '2.5')", () => {
    // Math.round(2.5) rendered "3" on the 2.5 gridline; formatCount keeps the label on its line.
    expect(yTicks(5, formatCount).map((t) => t.label)).toEqual(["5", "2.5", "0"]);
    expect(yTicks(15, formatCount).map((t) => t.label)).toEqual(["15", "7.5", "0"]);
    expect(yTicks(4, formatCount).map((t) => t.label)).toEqual(["4", "2", "0"]);
  });
});

describe("bucketNoun (#390 item 3)", () => {
  it("tracks the Day|Hour toggle", () => {
    expect(bucketNoun("day")).toBe("daily buckets");
    expect(bucketNoun("hour")).toBe("hourly buckets");
  });
});

describe("nearestBucketIndex", () => {
  it("maps fraction-of-width to the nearest index and clamps outside 0..1", () => {
    expect(nearestBucketIndex(0.5, 5)).toBe(2);
    expect(nearestBucketIndex(0.24, 5)).toBe(1);
    expect(nearestBucketIndex(-0.2, 5)).toBe(0);
    expect(nearestBucketIndex(1.5, 5)).toBe(4);
    expect(nearestBucketIndex(0.9, 1)).toBe(0);
  });
});

describe("emptyStateMessage", () => {
  it("single daily bucket suggests hourly buckets, counting the Runs", () => {
    expect(emptyStateMessage([point("2026-08-29T00:00:00.000Z", { runs: 7 })], "day"))
      .toBe("All 7 Runs fall in a single daily bucket — hourly buckets show the shape of one day");
  });

  it("single hourly bucket says charts appear at two buckets", () => {
    expect(emptyStateMessage([point("2026-08-29T14:00:00.000Z", { runs: 7 })], "hour"))
      .toBe("Charts appear once Runs span two time buckets.");
  });

  it("#390 item 4: a single Run in the day doesn't dead-end at Hour view (1 Run can't span 2 hourly buckets)", () => {
    expect(emptyStateMessage([point("2026-08-29T00:00:00.000Z", { runs: 1 })], "day"))
      .toBe("All 1 Run falls in a single daily bucket — charts appear once Runs span two time buckets.");
  });

  it("two or more buckets render charts", () => {
    expect(emptyStateMessage([point("2026-08-28T00:00:00.000Z"), point("2026-08-29T00:00:00.000Z")], "day")).toBeNull();
  });
});

describe("hoverReadout", () => {
  const lines = [{ value: (p: ReliabilitySeriesPoint) => p.executionCompletionRate, format: formatPercent }];

  it("shows label · value · Runs for an observed bucket", () => {
    const bucket = {
      bucket: "2026-08-29T00:00:00.000Z",
      label: "Aug 29",
      point: point("2026-08-29T00:00:00.000Z", { runs: 13, executionCompletionRate: 0.62 }),
    };
    expect(hoverReadout(bucket, lines)).toBe("Aug 29 · 62% · 13 Runs");
  });

  it("pluralizes a single Run and renders a null metric as —", () => {
    const bucket = {
      bucket: "2026-08-29T00:00:00.000Z",
      label: "Aug 29",
      point: point("2026-08-29T00:00:00.000Z", { runs: 1 }),
    };
    expect(hoverReadout(bucket, lines)).toBe("Aug 29 · — · 1 Run");
  });

  it("reads 'no Runs observed' for a synthesized gap bucket", () => {
    expect(hoverReadout({ bucket: "2026-08-28T00:00:00.000Z", label: "Aug 28", point: null }, lines))
      .toBe("Aug 28 · no Runs observed");
  });
});

describe("presetWindow (#369)", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  it("bounds `from` by the preset and leaves 'all' unwindowed", () => {
    expect(presetWindow("all", now)).toEqual({});
    expect(presetWindow("24h", now)).toEqual({ from: "2026-08-30T12:00:00.000Z" });
    expect(presetWindow("7d", now)).toEqual({ from: "2026-08-24T12:00:00.000Z" });
    expect(presetWindow("30d", now)).toEqual({ from: "2026-08-01T12:00:00.000Z" });
  });
});

describe("bucketDrillWindow (#369)", () => {
  it("covers exactly the bucket as inclusive ms bounds, hour and day", () => {
    expect(bucketDrillWindow("2026-08-29T14:00:00.000Z", "hour")).toEqual({
      from: "2026-08-29T14:00:00.000Z", to: "2026-08-29T14:59:59.999Z", label: "29 · 14:00",
    });
    expect(bucketDrillWindow("2026-08-29T00:00:00.000Z", "day")).toEqual({
      from: "2026-08-29T00:00:00.000Z", to: "2026-08-29T23:59:59.999Z", label: "Aug 29",
    });
  });
  it("refuses an unparseable bucket key", () => {
    expect(bucketDrillWindow("not-a-date", "day")).toBeNull();
  });
});

describe("synthesizeAxisPair (#369 overlay)", () => {
  it("spans both configurations' buckets and maps each side independently", () => {
    const a = [point("2026-08-27T00:00:00.000Z", { runs: 3 })];
    const b = [point("2026-08-29T00:00:00.000Z", { runs: 5 })];
    const axis = synthesizeAxisPair(a, b, "day");
    expect(axis.map((bucket) => bucket.bucket)).toEqual([
      "2026-08-27T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-29T00:00:00.000Z",
    ]);
    expect(axis.map((bucket) => bucket.point?.runs ?? null)).toEqual([3, null, null]);
    expect(axis.map((bucket) => bucket.bPoint?.runs ?? null)).toEqual([null, null, 5]);
  });
  it("is empty for two empty series and falls back to observed points past the gap-fill cap", () => {
    expect(synthesizeAxisPair([], [], "day")).toEqual([]);
    const a = [point("2020-01-01T00:00:00.000Z")];
    const b = [point("2026-08-29T14:00:00.000Z")];
    const axis = synthesizeAxisPair(a, b, "hour");
    expect(axis).toHaveLength(2);
    expect(axis[0].point).not.toBeNull();
    expect(axis[1].bPoint).not.toBeNull();
  });
});

describe("chartDeltaChips (#369)", () => {
  const deltas: ReliabilityDeltas = {
    runs: -2,
    executionCompletionRate: 0.045,
    taskCompletionRate: null,
    toolFailureRate: -0.25,
    avgToolCalls: 2,
    tokens: { avgInput: null, avgOutput: null, sum: null },
    latency: { p50: -200, p95: 0 },
    denialRate: 0,
    cost: { avg: 0.0042, sum: -1.5 },
  };
  it("renders signed raw deltas per chart and — for an unobserved side", () => {
    expect(chartDeltaChips("completion", deltas)).toEqual(["Δ execution +4.5 pp", "Δ task —"]);
    expect(chartDeltaChips("failure", deltas)).toEqual(["Δ tool failure −25 pp", "Δ denial 0 pp"]);
    expect(chartDeltaChips("latency", deltas)).toEqual(["Δ p50 −200 ms", "Δ p95 0 ms"]);
    expect(chartDeltaChips("cost", deltas)).toEqual(["Δ avg +$0.0042"]);
    expect(chartDeltaChips("volume", deltas)).toEqual(["Δ Runs −2"]);
  });
  it("renders no chips for the judge card — ReliabilityDeltas carries no judge-score deltas", () => {
    expect(chartDeltaChips("judge", deltas)).toEqual([]);
  });
});

describe("judge scores (#385)", () => {
  /** Fixture matching the #384 contract: judgeScores on each series point, meanScore on a 1–5 scale. */
  const judged = (bucket: string, taskScore: number | null): ReliabilitySeriesPoint => ({
    ...point(bucket, { runs: 2 }),
    judgeScores: taskScore === null ? [] : [
      { evaluatorId: "task_completion", version: 1, evaluated: 2, meanScore: taskScore },
      { evaluatorId: "recovery_quality", version: 1, evaluated: 2, meanScore: 5 },
    ],
  });
  const taskScore = (p: ReliabilitySeriesPoint): number | null =>
    p.judgeScores.find((s) => s.evaluatorId === "task_completion")?.meanScore ?? null;

  it("domainMax pins the score axis at 5 whatever was observed; rate stays 1; observed defers to niceMax", () => {
    expect(domainMax("score", [3.2, null, 4.1])).toBe(5);
    expect(domainMax("score", [])).toBe(5);
    expect(domainMax("rate", [0.4])).toBe(1);
    expect(domainMax("observed", [820, null, 300])).toBe(1000);
  });

  it("formatScore renders one decimal and yTicks(5, formatScore) reads 5.0/2.5/0.0", () => {
    expect(formatScore(4.2)).toBe("4.2");
    expect(formatScore(5)).toBe("5.0");
    expect(yTicks(5, formatScore).map((t) => t.label)).toEqual(["5.0", "2.5", "0.0"]);
  });

  it("a bucket with Runs but no judge verdicts maps to null and breaks the line — no interpolation", () => {
    const axis = synthesizeAxis([
      judged("2026-08-27T00:00:00.000Z", 4.2),
      judged("2026-08-28T00:00:00.000Z", null),
      judged("2026-08-29T00:00:00.000Z", 3),
    ], "day");
    const values = axis.map((b) => (b.point ? taskScore(b.point) : null));
    expect(values).toEqual([4.2, null, 3]);
    expect(linePath(values, 5)).toBe("M0 16 L0 16 M100 40 L100 40"); // two separate segments, gap in between
  });
});

describe("overlayHoverReadout (#369)", () => {
  const lines = [{ value: (p: ReliabilitySeriesPoint) => p.executionCompletionRate, format: formatPercent }];
  it("reads both sides at the cursor, with gap buckets stated per side", () => {
    const bucket = {
      bucket: "2026-08-29T00:00:00.000Z",
      label: "Aug 29",
      point: point("2026-08-29T00:00:00.000Z", { runs: 13, executionCompletionRate: 0.62 }),
      bPoint: null,
    };
    expect(overlayHoverReadout(bucket, lines)).toBe("Aug 29 · A: 62% · 13 Runs · B: no Runs observed");
    const both = { ...bucket, bPoint: point("2026-08-29T00:00:00.000Z", { runs: 1, executionCompletionRate: 0.5 }) };
    expect(overlayHoverReadout(both, lines)).toBe("Aug 29 · A: 62% · 13 Runs · B: 50% · 1 Run");
  });
});

describe("slotIndex (#369 volume bars)", () => {
  it("maps pointer fraction to the slot under it, clamped", () => {
    expect(slotIndex(0, 4)).toBe(0);
    expect(slotIndex(0.24, 4)).toBe(0);
    expect(slotIndex(0.26, 4)).toBe(1);
    expect(slotIndex(0.99, 4)).toBe(3);
    expect(slotIndex(1, 4)).toBe(3); // exact right edge stays in the last slot
    expect(slotIndex(-1, 4)).toBe(0);
    expect(slotIndex(0.5, 0)).toBe(0);
  });
});
