// ponytail: one runnable check for the chart math behind MetricsDashboard (#342). Run from repo root:
//   npx vitest run apps/web/src/charts-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { ReliabilityNumbers, ReliabilitySeriesPoint } from "./types";
import { formatDuration } from "./runs-view-model";
import { formatPercent } from "./reliability-view-model";
import {
  bucketLabel,
  emptyStateMessage,
  hoverReadout,
  linePath,
  nearestBucketIndex,
  niceMax,
  synthesizeAxis,
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
};

function point(bucket: string, overrides: Partial<ReliabilityNumbers> = {}): ReliabilitySeriesPoint {
  return { bucket, ...emptyNumbers, ...overrides };
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
