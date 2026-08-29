// ponytail: one runnable check for the reliability tile formatting (#173). Run from repo root:
//   npx vitest run apps/web/src/reliability-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { ReliabilityNumbers, ReliabilityReport, ReliabilitySeriesPoint } from "./types";
import { formatAverage, formatPercent, reliabilityTiles, sampledDetail, sparklineHeights, taskCompletionDetail } from "./reliability-view-model";

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

function report(overrides: Partial<ReliabilityReport> = {}): ReliabilityReport {
  return {
    schemaVersion: "1.0",
    capturePolicy: "metadata_only",
    agentId: "agent-1",
    ...emptyNumbers,
    series: [],
    provenance: { count: 0, filter: { agentId: "agent-1" } },
    ...overrides,
  };
}

function point(bucket: string, overrides: Partial<ReliabilityNumbers> = {}): ReliabilitySeriesPoint {
  return { bucket, ...emptyNumbers, ...overrides };
}

describe("formatPercent", () => {
  it.each<[number | null, string]>([
    [null, "—"],
    [0, "0%"],
    [0.5, "50%"],
    [1, "100%"],
    [1 / 3, "33.3%"],
    [2 / 3, "66.7%"],
  ])("%s → %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });
});

describe("formatAverage", () => {
  it("renders null as — (no observation is not zero) and one decimal otherwise", () => {
    expect(formatAverage(null)).toBe("—");
    expect(formatAverage(3)).toBe("3");
    expect(formatAverage(3.25)).toBe("3.3");
  });
});

describe("taskCompletionDetail", () => {
  it("carries the evaluated/passed provenance and the evaluator id + version", () => {
    expect(taskCompletionDetail({ evaluatorId: "task_completion", version: 1, evaluated: 3, passed: 2, rate: 2 / 3 }, 5))
      .toBe("3 of 5 Runs evaluated · 2 passed · task_completion@1");
  });
});

describe("sampledDetail", () => {
  it("names the partial sample and stays silent when every Run was observed", () => {
    expect(sampledDetail(4, 6)).toBe("sampled 4 of 6 Runs");
    expect(sampledDetail(6, 6)).toBe("");
  });
});

describe("reliabilityTiles", () => {
  it("formats rates as percentages, latency as durations, tokens as counts — with per-bucket series", () => {
    const tiles = reliabilityTiles(report({
      runs: 4,
      executionCompletionRate: 0.75,
      taskCompletionRate: { evaluatorId: "task_completion", version: 2, evaluated: 2, passed: 1, rate: 0.5 },
      toolFailureRate: 0.1,
      avgToolCalls: 3.5,
      tokens: { avgInput: 1500, avgOutput: 200.4, sum: 6800, sampled: 4 },
      latency: { p50: 1200, p95: 3000, sampled: 3 },
      denialRate: 0,
      series: [
        point("2026-08-27", { executionCompletionRate: 1, latency: { p50: 900, p95: 900, sampled: 1 } }),
        point("2026-08-28", { executionCompletionRate: 0.5 }),
      ],
    }));
    const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
    expect(byKey.executionCompletionRate).toMatchObject({ value: "75%", kind: "telemetry", series: [1, 0.5] });
    expect(byKey.taskCompletionRate).toMatchObject({
      value: "50%",
      kind: "evaluation",
      detail: "2 of 4 Runs evaluated · 1 passed · task_completion@2",
      series: [null, null],
    });
    expect(byKey.toolFailureRate?.value).toBe("10%");
    expect(byKey.denialRate?.value).toBe("0%");
    expect(byKey.avgToolCalls?.value).toBe("3.5");
    expect(byKey.tokens?.value).toBe("1.5k in · 200 out");
    expect(byKey.tokens?.detail).toBeUndefined(); // sampled 4 of 4 — the sample is complete
    expect(byKey.latency).toMatchObject({ value: "p50 1.2 s · p95 3.0 s", detail: "sampled 3 of 4 Runs", series: [900, null] });
  });

  it("renders every unobserved metric as — instead of claiming zero", () => {
    const tiles = reliabilityTiles(report({ runs: 2 }));
    const values = Object.fromEntries(tiles.map((tile) => [tile.key, tile.value]));
    expect(values).toEqual({
      executionCompletionRate: "—",
      taskCompletionRate: "—",
      toolFailureRate: "—",
      denialRate: "—",
      avgToolCalls: "—",
      tokens: "—",
      latency: "—",
    });
  });

  it("fixes the sparkline scale at 1 for the four 0–1 rate tiles only", () => {
    const byKey = Object.fromEntries(reliabilityTiles(report({ runs: 2 })).map((tile) => [tile.key, tile]));
    for (const key of ["executionCompletionRate", "taskCompletionRate", "toolFailureRate", "denialRate"]) expect(byKey[key]?.sparklineMax).toBe(1);
    for (const key of ["avgToolCalls", "tokens", "latency"]) expect(byKey[key]?.sparklineMax).toBeUndefined();
  });

  it("drills only where the Runs table states the provenance exactly (#173): all Runs, and failed tasks", () => {
    const byKey = Object.fromEntries(reliabilityTiles(report({ runs: 2 })).map((tile) => [tile.key, tile]));
    expect(byKey.executionCompletionRate?.drill).toEqual({ quick: "all", taskOutcome: "all" });
    expect(byKey.taskCompletionRate?.drill).toEqual({ quick: "all", taskOutcome: "failed" });
    for (const key of ["toolFailureRate", "denialRate", "avgToolCalls", "tokens", "latency"]) expect(byKey[key]?.drill).toBeUndefined();
  });
});

describe("sparklineHeights", () => {
  it("scales to the series max and keeps nulls null", () => {
    expect(sparklineHeights([1, 0.5, null, 0])).toEqual([100, 50, null, 0]);
  });

  it("handles all-zero and empty series without dividing by zero", () => {
    expect(sparklineHeights([0, 0])).toEqual([0, 0]);
    expect(sparklineHeights([])).toEqual([]);
    expect(sparklineHeights([null])).toEqual([null]);
  });

  it("scales to a fixed max when given one, so a flat 50% no longer renders like a flat 100%", () => {
    expect(sparklineHeights([0.5, 0.5], 1)).toEqual([50, 50]);
    expect(sparklineHeights([1, 0.25, null], 1)).toEqual([100, 25, null]);
  });
});
