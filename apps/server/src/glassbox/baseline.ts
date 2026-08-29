import { computeMetric, percentile, type MetricName, type MetricQuery } from "./metrics.js";
import type { RunSummary } from "./summary.js";
import { estimatedCost, type TokenPricing } from "./cost.js";

export { estimatedCost, type TokenPricing } from "./cost.js";

export interface BaselineDistribution {
  p50?: number | undefined;
  p95?: number | undefined;
}

export const BASELINE_WINDOW = 20;
/**
 * Store-side bound for the route's summary query (#213): enough headroom over the window that a handful of
 * in-flight rows cannot displace terminal evidence, without a full-table scan on the Postgres backend.
 */
export const BASELINE_QUERY_LIMIT = 40;

export interface AgentRunBaseline {
  sampleCount: number;
  windowSize: typeof BASELINE_WINDOW;
  durationMs: BaselineDistribution;
  inputTokens: BaselineDistribution;
  toolCalls: BaselineDistribution;
  toolFailures: BaselineDistribution;
  estimatedCostUsd?: BaselineDistribution | undefined;
}

function distribution(values: Array<number | undefined>): BaselineDistribution {
  const sorted = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  return { ...(p50 === null ? {} : { p50 }), ...(p95 === null ? {} : { p95 }) };
}

/**
 * FR-23 sugar (#208/#213): the catalogue-representable columns are literal `computeMetric` calls over
 * `range: { lastRuns: 20 }`, so the baseline can never disagree with `POST /api/metrics/query` on the same
 * window. `executionStatus != running` is not expressible as a catalogue filter, so terminal Runs are
 * pre-filtered here; `computeMetric`'s window predicates are idempotent over pre-filtered rows.
 * `inputTokens` keeps the `usage` fallback the runs list and outlier chips compare against. Cost is hydrated
 * only for legacy rows that predate rollup version 7; new rows use the persisted catalogue metric.
 */
export function buildAgentRunBaseline(summaries: RunSummary[], pricing: TokenPricing = {}): AgentRunBaseline {
  const legacyWindow = summaries.filter((summary) => summary.executionStatus !== "running")
    .sort((a, b) => (b.startedAt ?? b.updatedAt).localeCompare(a.startedAt ?? a.updatedAt) || a.runId.localeCompare(b.runId))
    .slice(0, BASELINE_WINDOW);
  const window = legacyWindow.map((summary) => {
    if (summary.estimatedCostUsd !== undefined) return summary;
    const cost = estimatedCost(summary, pricing);
    return cost === undefined ? summary : { ...summary, estimatedCostUsd: cost };
  });
  const catalogue = (metric: MetricName): BaselineDistribution => {
    const stat = (statistic: "p50" | "p95"): number | null => {
      const query: MetricQuery = { metric, aggregation: { type: statistic }, range: { lastRuns: BASELINE_WINDOW } };
      const { value } = computeMetric(query, window);
      return typeof value === "number" ? value : null;
    };
    const p50 = stat("p50");
    const p95 = stat("p95");
    return { ...(p50 === null ? {} : { p50 }), ...(p95 === null ? {} : { p95 }) };
  };
  const baseline: AgentRunBaseline = {
    sampleCount: window.length,
    windowSize: BASELINE_WINDOW,
    durationMs: catalogue("latency"),
    inputTokens: distribution(window.map((summary) => summary.usage?.inputTokens ?? summary.metrics.tokens?.input)),
    toolCalls: catalogue("tool_calls"),
    toolFailures: catalogue("tool_failures"),
  };
  const costs = catalogue("estimated_cost_usd");
  return costs.p50 === undefined ? baseline : { ...baseline, estimatedCostUsd: costs };
}
