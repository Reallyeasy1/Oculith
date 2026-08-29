import { describe, expect, it } from "vitest";
import { budgetWindowStart, BUDGET_WINDOW_MS, describeBudgetDenial, evaluateBudget, normalizeBudget, usageInWindow } from "./budget.js";
import { buildTrace } from "./query.js";
import { summaryFromView, type RunSummary } from "./summary.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const WINDOW_START = budgetWindowStart(NOW);

const stub = (over: Partial<RunSummary>): RunSummary => ({
  ...summaryFromView(buildTrace([], { capturePolicy: "metadata_only" })),
  runId: "r", traceId: "t", agentId: "agt-1", executionStatus: "completed", eventCount: 1,
  updatedAt: NOW.toISOString(), startedAt: "2026-08-29T10:00:00.000Z", ...over,
});
const withTokens = (over: Partial<RunSummary>, tokens: { input: number; output: number }): RunSummary => {
  const base = stub(over);
  return { ...base, metrics: { ...base.metrics, tokens } };
};

describe("budgetWindowStart", () => {
  it("is exactly 24 h before now", () => {
    expect(Date.parse(NOW.toISOString()) - Date.parse(WINDOW_START)).toBe(BUDGET_WINDOW_MS);
  });
});

describe("usageInWindow", () => {
  it("sums input + output from usage, never double-counting cached or reasoning subsets", () => {
    const usage = usageInWindow([
      stub({ runId: "r1", usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 40, reasoningOutputTokens: 10 } }),
      stub({ runId: "r2", usage: { inputTokens: 50, outputTokens: 10 } }),
    ], WINDOW_START);
    expect(usage).toMatchObject({ totalTokens: 200, runs: 2 });
  });

  it("falls back to metrics.tokens when the runner reported no usage (same fallback as cost)", () => {
    const usage = usageInWindow([withTokens({ runId: "r1", usage: undefined }, { input: 30, output: 20 })], WINDOW_START);
    expect(usage).toMatchObject({ totalTokens: 50, runs: 1 });
  });

  it("skips running Runs and Runs started before the window (or with no startedAt)", () => {
    const usage = usageInWindow([
      stub({ runId: "r1", executionStatus: "running", usage: { inputTokens: 999, outputTokens: 999 } }),
      stub({ runId: "r2", startedAt: "2026-08-27T12:00:00.000Z", usage: { inputTokens: 999, outputTokens: 999 } }),
      stub({ runId: "r3", startedAt: undefined, usage: { inputTokens: 999, outputTokens: 999 } }),
      stub({ runId: "r4", usage: { inputTokens: 7, outputTokens: 3 } }),
    ], WINDOW_START);
    expect(usage).toMatchObject({ totalTokens: 10, runs: 1 });
  });

  it("counts failed/timeout/cancelled terminal Runs — their tokens were spent too", () => {
    const usage = usageInWindow([
      stub({ runId: "r1", executionStatus: "failed", usage: { inputTokens: 5, outputTokens: 5 } }),
      stub({ runId: "r2", executionStatus: "timeout", usage: { inputTokens: 5, outputTokens: 5 } }),
      stub({ runId: "r3", executionStatus: "cancelled", usage: { inputTokens: 5, outputTokens: 5 } }),
    ], WINDOW_START);
    expect(usage).toMatchObject({ totalTokens: 30, runs: 3 });
  });

  it("sums persisted estimatedCostUsd and treats a missing cost as zero", () => {
    const usage = usageInWindow([
      stub({ runId: "r1", estimatedCostUsd: 0.25 }),
      stub({ runId: "r2", estimatedCostUsd: 0.5 }),
      stub({ runId: "r3" }),
    ], WINDOW_START);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.75, 10);
  });
});

describe("evaluateBudget", () => {
  const usage = { totalTokens: 1_000, estimatedCostUsd: 0.5, runs: 3, windowStart: WINDOW_START };

  it("passes under both limits and with no limits", () => {
    expect(evaluateBudget({ maxTokensPerDay: 1_001, maxEstimatedUsdPerDay: 0.51 }, usage)).toBeUndefined();
    expect(evaluateBudget({}, usage)).toBeUndefined();
  });

  it("refuses at the limit exactly — 'stops at N' means N", () => {
    expect(evaluateBudget({ maxTokensPerDay: 1_000 }, usage)).toMatchObject({
      decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: 1_000, used: 1_000,
    });
  });

  it("checks the USD limit independently", () => {
    expect(evaluateBudget({ maxTokensPerDay: 2_000, maxEstimatedUsdPerDay: 0.25 }, usage)).toMatchObject({
      decision: "budget_exceeded", limit: "maxEstimatedUsdPerDay", limitValue: 0.25, used: 0.5,
    });
  });
});

describe("normalizeBudget", () => {
  it("keeps set limits, drops unset ones, and turns null/empty into undefined", () => {
    expect(normalizeBudget({ maxTokensPerDay: 10, maxEstimatedUsdPerDay: undefined })).toEqual({ maxTokensPerDay: 10 });
    expect(normalizeBudget(null)).toBeUndefined();
    expect(normalizeBudget({})).toBeUndefined();
    expect(normalizeBudget(undefined)).toBeUndefined();
  });
});

describe("describeBudgetDenial", () => {
  it("names the limit that tripped without leaking anything but numbers", () => {
    expect(describeBudgetDenial({ decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: 100, used: 120 }))
      .toContain("120 tokens");
    expect(describeBudgetDenial({ decision: "budget_exceeded", limit: "maxEstimatedUsdPerDay", limitValue: 1, used: 1.5 }))
      .toContain("$1.5000");
  });
});
