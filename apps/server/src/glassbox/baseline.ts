import type { RunSummary } from "./summary.js";

export interface BaselineDistribution {
  median?: number | undefined;
  p90?: number | undefined;
}

export interface AgentRunBaseline {
  sampleCount: number;
  windowSize: 20;
  durationMs: BaselineDistribution;
  inputTokens: BaselineDistribution;
  toolCalls: BaselineDistribution;
  toolFailures: BaselineDistribution;
  estimatedCostUsd?: BaselineDistribution | undefined;
}

export interface TokenPricing {
  inputPerMillion?: number | undefined;
  outputPerMillion?: number | undefined;
}

function distribution(values: Array<number | undefined>): BaselineDistribution {
  const sorted = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return {};
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  // Nearest-rank p90: the smallest observed value whose cumulative proportion is at least 90%.
  const p90 = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)]!;
  return { median, p90 };
}

export function estimatedCost(summary: RunSummary, pricing: TokenPricing): number | undefined {
  const input = summary.usage?.inputTokens ?? summary.metrics.tokens?.input;
  const output = summary.usage?.outputTokens ?? summary.metrics.tokens?.output;
  const hasInput = input !== undefined && pricing.inputPerMillion !== undefined;
  const hasOutput = output !== undefined && pricing.outputPerMillion !== undefined;
  if (!hasInput && !hasOutput) return undefined;
  return ((hasInput ? input! * pricing.inputPerMillion! : 0) + (hasOutput ? output! * pricing.outputPerMillion! : 0)) / 1_000_000;
}

export function buildAgentRunBaseline(summaries: RunSummary[], pricing: TokenPricing = {}): AgentRunBaseline {
  const terminal = summaries.filter((summary) => summary.executionStatus !== "running").slice(0, 20);
  const baseline: AgentRunBaseline = {
    sampleCount: terminal.length,
    windowSize: 20,
    durationMs: distribution(terminal.map((summary) => summary.durationMs)),
    inputTokens: distribution(terminal.map((summary) => summary.usage?.inputTokens ?? summary.metrics.tokens?.input)),
    toolCalls: distribution(terminal.map((summary) => summary.metrics.toolCalls)),
    toolFailures: distribution(terminal.map((summary) => summary.metrics.toolFailures)),
  };
  const costs = distribution(terminal.map((summary) => estimatedCost(summary, pricing)));
  return costs.median === undefined ? baseline : { ...baseline, estimatedCostUsd: costs };
}
