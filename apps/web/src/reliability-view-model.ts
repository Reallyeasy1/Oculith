import type { ReliabilityReport, ReliabilitySeriesPoint, TaskCompletionRate } from "./types";
import { formatCount, formatDuration, type QuickFilter, type TaskOutcomeFilter } from "./runs-view-model";

// Pure formatting for ReliabilityPanel (#173). A `null` from the API renders as "—" — zero is a claim
// the server deliberately did not make (reliability.ts documents each semantic).

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value * 1000) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%";
}

export function formatAverage(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The evaluated/passed provenance the issue asks for: "3 of 5 Runs evaluated · 2 passed · task_completion@1". */
export function taskCompletionDetail(taskCompletion: TaskCompletionRate, runs: number): string {
  return `${taskCompletion.evaluated} of ${runs} Runs evaluated · ${taskCompletion.passed} passed · ${taskCompletion.evaluatorId}@${taskCompletion.version}`;
}

/** "sampled 4 of 6 Runs" when not every Run observed the metric; empty when the sample is complete. */
export function sampledDetail(sampled: number, runs: number): string {
  return sampled === runs ? "" : `sampled ${sampled} of ${runs} Runs`;
}

/** #173 drill-back: the Runs-table filters that show the Runs behind a tile's number. */
export interface ReliabilityDrill {
  quick: QuickFilter;
  taskOutcome: TaskOutcomeFilter;
  /** Exact provenance for a config-comparison cell (#174); absent for ordinary dashboard drills. */
  runIds?: string[];
}

export interface ReliabilityTile {
  key: string;
  label: string;
  /** telemetry = observed RunSummary rows; evaluation = stored evaluator verdicts (#172 keeps the families distinct). */
  kind: "telemetry" | "evaluation";
  value: string;
  detail?: string;
  /** This tile's metric per series bucket, for the sparkline; null buckets stay null. */
  series: (number | null)[];
  /** Fixed sparkline scale for bounded metrics (1 for the 0–1 rates) so a flat 50% never renders like a flat 100%. */
  sparklineMax?: number;
  /** Present only where the Runs table can express the tile's provenance exactly; absent tiles are not clickable. */
  drill?: ReliabilityDrill;
}

export function reliabilityTiles(report: ReliabilityReport): ReliabilityTile[] {
  const of = (value: (point: ReliabilitySeriesPoint) => number | null): (number | null)[] => report.series.map(value);
  const tokensValue = report.tokens.avgInput === null && report.tokens.avgOutput === null
    ? "—"
    : `${formatCount(report.tokens.avgInput === null ? undefined : Math.round(report.tokens.avgInput))} in · ${formatCount(report.tokens.avgOutput === null ? undefined : Math.round(report.tokens.avgOutput))} out`;
  const latencyValue = report.latency.p50 === null
    ? "—"
    : `p50 ${formatDuration(report.latency.p50)} · p95 ${formatDuration(report.latency.p95 ?? undefined)}`;
  const detail = (text: string): { detail?: string } => (text ? { detail: text } : {});
  return [
    // ponytail: drills only where a Runs-table filter states the provenance exactly — execution completion is
    // "every Run", task completion drills to the demo's problematic Runs (completed process, failed task).
    { key: "executionCompletionRate", label: "Execution completion", kind: "telemetry", value: formatPercent(report.executionCompletionRate), series: of((point) => point.executionCompletionRate), sparklineMax: 1, drill: { quick: "all", taskOutcome: "all" } },
    { key: "taskCompletionRate", label: "Task completion", kind: "evaluation", value: formatPercent(report.taskCompletionRate.rate), ...detail(taskCompletionDetail(report.taskCompletionRate, report.runs)), series: of((point) => point.taskCompletionRate.rate), sparklineMax: 1, drill: { quick: "all", taskOutcome: "failed" } },
    { key: "toolFailureRate", label: "Tool failure rate", kind: "telemetry", value: formatPercent(report.toolFailureRate), series: of((point) => point.toolFailureRate), sparklineMax: 1 },
    { key: "denialRate", label: "Denial rate", kind: "telemetry", value: formatPercent(report.denialRate), series: of((point) => point.denialRate), sparklineMax: 1 },
    { key: "avgToolCalls", label: "Avg tool calls", kind: "telemetry", value: formatAverage(report.avgToolCalls), series: of((point) => point.avgToolCalls) },
    { key: "tokens", label: "Avg tokens", kind: "telemetry", value: tokensValue, ...detail(sampledDetail(report.tokens.sampled, report.runs)), series: of((point) => point.tokens.avgOutput) },
    { key: "latency", label: "Latency", kind: "telemetry", value: latencyValue, ...detail(sampledDetail(report.latency.sampled, report.runs)), series: of((point) => point.latency.p95) },
  ];
}

/** Bar heights as 0–100 % of `fixedMax` (bounded metrics, e.g. 1 for rates) or, absent one, the series max;
 * null stays null (no observation is not zero). */
export function sparklineHeights(values: readonly (number | null)[], fixedMax?: number): (number | null)[] {
  const observed = values.filter((value): value is number => value !== null);
  const max = fixedMax ?? (observed.length === 0 ? 0 : Math.max(...observed));
  return values.map((value) => (value === null ? null : max === 0 ? 0 : Math.round((value / max) * 100)));
}
