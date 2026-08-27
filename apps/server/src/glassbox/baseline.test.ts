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
  it("hand-computes medians and nearest-rank p90 over the newest 20 terminal Runs", () => {
    const summaries = [summary(99, { executionStatus: "running" }), ...Array.from({ length: 25 }, (_, index) => summary(index + 1))];
    const result = buildAgentRunBaseline(summaries, { inputPerMillion: 2, outputPerMillion: 4 });
    expect(result).toMatchObject({
      sampleCount: 20,
      windowSize: 20,
      durationMs: { median: 10_500, p90: 18_000 },
      inputTokens: { median: 1_050, p90: 1_800 },
      toolCalls: { median: 10.5, p90: 18 },
      toolFailures: { median: 1, p90: 2 },
    });
    expect(result.estimatedCostUsd?.median).toBeCloseTo(0.00252);
    expect(result.estimatedCostUsd?.p90).toBeCloseTo(0.00432);
  });

  it("keeps missing observations absent and never treats a running Run as baseline history", () => {
    const result = buildAgentRunBaseline([
      summary(1, { durationMs: undefined, usage: undefined, metrics: { terminalStatus: "ok", toolCalls: 0, toolFailures: 0, modelCalls: 0, retries: 0, denials: 0 } }),
      summary(2, { executionStatus: "running" }),
    ]);
    expect(result).toEqual({ sampleCount: 1, windowSize: 20, durationMs: {}, inputTokens: {}, toolCalls: { median: 0, p90: 0 }, toolFailures: { median: 0, p90: 0 } });
  });

  it("prices only token classes with an observed count and configured rate", () => {
    expect(estimatedCost(summary(2), { inputPerMillion: 2 })).toBe(0.0004);
    expect(estimatedCost(summary(2), {})).toBeUndefined();
  });
});
