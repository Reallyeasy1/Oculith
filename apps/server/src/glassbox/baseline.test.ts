import { describe, expect, it } from "vitest";
import { buildAgentRunBaseline, estimatedCost } from "./baseline.js";
import type { RunSummary } from "./summary.js";

function summary(index: number, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `run-${index}`, traceId: `trace-${index}`, agentId: "agent-a", capturePolicy: "metadata_only",
    executionStatus: "completed", taskOutcome: "unknown", startedAt: new Date(2026, 0, index + 1).toISOString(),
    durationMs: index * 1_000, metrics: { terminalStatus: "ok", toolCalls: index, toolFailures: index % 3,
      modelCalls: 1, tokens: { input: index * 10, output: index }, retries: 0, denials: 0 },
    usage: { inputTokens: index * 100, outputTokens: index * 10 }, denials: 0, actions: 0,
    capabilities: { model: "observed", tool: "observed" }, degraded: false, truncated: false, evicted: false,
    redactedEvents: 0, eventCount: 1, rollupVersion: 1, updatedAt: new Date(2026, 0, index + 1).toISOString(),
    ...extra,
  };
}

describe("buildAgentRunBaseline", () => {
  // #213: nearest-rank p50/p95 shared with the metric catalogue; the window is the newest 20 terminal
  // Runs by startedAt regardless of the caller's array order (indices 6..25 of this ascending fixture).
  it("hand-computes nearest-rank p50/p95 over the newest 20 terminal Runs", () => {
    const summaries = [summary(99, { executionStatus: "running" }), ...Array.from({ length: 25 }, (_, index) => summary(index + 1))];
    const result = buildAgentRunBaseline(summaries, { inputPerMillion: 2, outputPerMillion: 4 });
    expect(result).toMatchObject({
      sampleCount: 20,
      windowSize: 20,
      durationMs: { p50: 15_000, p95: 24_000 },
      inputTokens: { p50: 1_500, p95: 2_400 },
      toolCalls: { p50: 15, p95: 24 },
      toolFailures: { p50: 1, p95: 2 },
    });
    expect(result.estimatedCostUsd?.p50).toBeCloseTo(0.0036);
    expect(result.estimatedCostUsd?.p95).toBeCloseTo(0.00576);
  });

  it("keeps missing observations absent and never treats a running Run as baseline history", () => {
    const result = buildAgentRunBaseline([
      summary(1, { durationMs: undefined, usage: undefined, metrics: { terminalStatus: "ok", toolCalls: 0, toolFailures: 0, modelCalls: 0, retries: 0, denials: 0 } }),
      summary(2, { executionStatus: "running" }),
    ]);
    expect(result).toEqual({ sampleCount: 1, windowSize: 20, durationMs: {}, inputTokens: {}, toolCalls: { p50: 0, p95: 0 }, toolFailures: { p50: 0, p95: 0 } });
  });

  it("prices only token classes with an observed count and configured rate", () => {
    expect(estimatedCost(summary(2), { inputPerMillion: 2 })).toBe(0.0004);
    expect(estimatedCost(summary(2), {})).toBeUndefined();
  });

  it("prices cached input separately and falls back to the input rate", () => {
    const cached = summary(2, { usage: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 20 } });
    expect(estimatedCost(cached, { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 })).toBe(0.00043);
    expect(estimatedCost(cached, { inputPerMillion: 2 })).toBe(0.0004);
  });
});
