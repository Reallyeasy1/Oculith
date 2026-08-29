import { z } from "zod";
import { HttpError } from "../errors.js";
import type { EvaluationResult, EvaluationStore } from "./evaluation.js";
import { SCHEMA_VERSION } from "./schema.js";
import type { ExecutionStatus, RunSummary, RunSummaryStore, TaskOutcome } from "./summary.js";

/**
 * FR-23: one bounded metric query contract over a fixed catalogue — no expressions, no free-form query
 * language. Telemetry metrics come from `RunSummary` rows (the #168 rollup); the one evaluation metric,
 * `task_completion`, comes from `EvaluationResult`s parameterised by evaluator id + version. The two planes
 * are labelled (`kind`) and never folded into one number, and every response carries provenance.
 */
export const METRIC_NAMES = ["execution_completion", "tool_failure_rate", "tool_calls", "tool_failures", "tokens", "latency", "denials", "estimated_cost_usd", "task_completion"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export type MetricKind = "telemetry" | "evaluation";
export const SCALAR_AGGREGATIONS = ["rate", "avg", "p50", "p95", "count"] as const;
export type ScalarAggregation = (typeof SCALAR_AGGREGATIONS)[number];

/**
 * Which aggregations each metric answers. `count` sums the per-Run samples (total tool calls, total tokens,
 * total denials; for `execution_completion` the number of completed Runs) — the Run count itself is always
 * `provenance.count`. `rate` semantics per metric: `execution_completion` = completed / terminal Runs
 * (running Runs are excluded from both sides — an in-flight Run is not a failure); `tool_failure_rate` =
 * Σ toolFailures / Σ toolCalls across the window (a micro-average: per-Run ratios are undefined for 0-call
 * Runs and would let a 1-call Run outweigh a 100-call one); `task_completion` = passed / evaluated Runs
 * (unevaluated Runs are excluded from both sides, and `provenance.evaluated` says how many were evaluated).
 */
export const METRIC_CATALOGUE: Record<MetricName, { kind: MetricKind; aggregations: readonly ScalarAggregation[] }> = {
  execution_completion: { kind: "telemetry", aggregations: ["rate", "count"] },
  tool_failure_rate: { kind: "telemetry", aggregations: ["rate"] },
  tool_calls: { kind: "telemetry", aggregations: ["avg", "p50", "p95", "count"] },
  tool_failures: { kind: "telemetry", aggregations: ["avg", "p50", "p95", "count"] },
  tokens: { kind: "telemetry", aggregations: ["avg", "p50", "p95", "count"] },
  latency: { kind: "telemetry", aggregations: ["avg", "p50", "p95"] },
  denials: { kind: "telemetry", aggregations: ["count", "avg"] },
  estimated_cost_usd: { kind: "telemetry", aggregations: ["rate", "avg", "p50", "p95"] },
  task_completion: { kind: "evaluation", aggregations: ["rate"] },
};

const EXECUTION_STATUSES = ["running", "completed", "failed", "timeout", "cancelled"] as const satisfies readonly ExecutionStatus[];
const TASK_OUTCOMES = ["passed", "failed", "unknown"] as const satisfies readonly TaskOutcome[];

const scalarAggregation = z.enum(SCALAR_AGGREGATIONS);
// Normalised to millisecond precision: stored `startedAt` is always `.SSSZ`, and the bounds compare
// lexicographically, so an un-normalised second-precision `from` would exclude a Run it names exactly.
export const isoDatetime = z.string().datetime().transform((value) => new Date(value).toISOString());
const metricFilter = z.strictObject({
  agentId: z.string().min(1).max(200).optional(),
  configHash: z.string().min(1).max(64).optional(),
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  executionStatus: z.enum(EXECUTION_STATUSES).optional(),
  taskOutcome: z.enum(TASK_OUTCOMES).optional(),
});
// A strict union: `lastRuns` and a time window cannot be mixed in one range.
const metricRange = z.union([
  z.strictObject({ lastRuns: z.number().int().min(1).max(10_000) }),
  z.strictObject({ from: isoDatetime.optional(), to: isoDatetime.optional() }),
]);

export const metricQueryBody = z.strictObject({
  metric: z.enum(METRIC_NAMES, { error: `Unknown metric; the catalogue is: ${METRIC_NAMES.join(", ")}` }),
  filter: metricFilter.optional(),
  range: metricRange.optional(),
  aggregation: z.union([
    z.strictObject({ type: scalarAggregation }),
    // series is not a seventh statistic: it buckets the window and applies a scalar cell per bucket.
    z.strictObject({ type: z.literal("series"), bucket: z.enum(["hour", "day"]), statistic: scalarAggregation }),
  ]),
  tokens: z.strictObject({ field: z.enum(["input", "output", "total"]) }).optional(),
  evaluator: z.strictObject({ id: z.string().min(1).max(200), version: z.number().int().min(1).optional() }).optional(),
}).superRefine((query, ctx) => {
  const { aggregations } = METRIC_CATALOGUE[query.metric];
  const statistic = query.aggregation.type === "series" ? query.aggregation.statistic : query.aggregation.type;
  if (!aggregations.includes(statistic)) {
    ctx.addIssue({ code: "custom", path: ["aggregation"], message: `"${statistic}" is not valid for "${query.metric}"; valid aggregations: ${aggregations.join(", ")}` });
  }
  if (query.metric === "task_completion" && !query.evaluator) ctx.addIssue({ code: "custom", path: ["evaluator"], message: `"task_completion" requires evaluator { id, version? }` });
  if (query.metric !== "task_completion" && query.evaluator) ctx.addIssue({ code: "custom", path: ["evaluator"], message: `evaluator only parameterises "task_completion"` });
  if (query.metric !== "tokens" && query.tokens) ctx.addIssue({ code: "custom", path: ["tokens"], message: `tokens.field only parameterises "tokens"` });
});
export type MetricQuery = z.infer<typeof metricQueryBody>;
export type MetricFilter = z.infer<typeof metricFilter>;

/** Above this window size runIds are not inlined; the effective-filter echo is the drill-back contract. */
export const PROVENANCE_RUN_ID_CAP = 100;

export interface MetricProvenance {
  /** Runs matching filter + range (the window). */ count: number;
  /** Runs that actually contributed a sample — missing fields are excluded, never averaged over. */ sampled: number;
  runIds?: string[] | undefined;
  /** The effective filter after range∩filter, echoed so a caller can drill down to exactly these Runs. */
  filter: MetricFilter & { lastRuns?: number | undefined };
  evaluatorId?: string | undefined; version?: number | undefined;
  /** task_completion only: how many window Runs had a result from this evaluator version. */ evaluated?: number | undefined;
}
export interface SeriesPoint { bucket: string; value: number | null; count: number; sampled: number }
export interface MetricResult {
  schemaVersion: typeof SCHEMA_VERSION;
  metric: MetricName;
  kind: MetricKind;
  aggregation: MetricQuery["aggregation"];
  /** A scalar (`null` when nothing was observed — zero is a claim), or the bucketed points for series. */
  value: number | null | SeriesPoint[];
  provenance: MetricProvenance;
}

/**
 * Nearest-rank percentile on ascending-sorted samples: `sorted[ceil(q·n) − 1]`. No interpolation — the
 * returned value is always one a Run actually exhibited (an interpolated p95 latency is a latency no Run
 * ever had). Empty input → null.
 */
export function percentile(sortedAscending: readonly number[], q: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(q * sortedAscending.length) - 1));
  return sortedAscending[rank] ?? null;
}

interface EffectiveWindow { filter: MetricFilter; lastRuns: number | undefined }

/** Merges `filter` and `range`: both bound `startedAt`, so overlapping from/to intersect (max from, min to). */
export function effectiveWindow(query: MetricQuery): EffectiveWindow {
  const filter = query.filter ?? {};
  const range = query.range ?? {};
  const lastRuns = "lastRuns" in range ? range.lastRuns : undefined;
  const rangeFrom = "from" in range ? range.from : undefined;
  const rangeTo = "to" in range ? range.to : undefined;
  const from = filter.from !== undefined && rangeFrom !== undefined ? (filter.from >= rangeFrom ? filter.from : rangeFrom) : filter.from ?? rangeFrom;
  const to = filter.to !== undefined && rangeTo !== undefined ? (filter.to <= rangeTo ? filter.to : rangeTo) : filter.to ?? rangeTo;
  return {
    filter: {
      ...(filter.agentId !== undefined ? { agentId: filter.agentId } : {}),
      ...(filter.configHash !== undefined ? { configHash: filter.configHash } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(filter.executionStatus !== undefined ? { executionStatus: filter.executionStatus } : {}),
      ...(filter.taskOutcome !== undefined ? { taskOutcome: filter.taskOutcome } : {}),
    },
    lastRuns,
  };
}

export const tokensOf = (summary: RunSummary, field: "input" | "output" | "total"): number | undefined => {
  const tokens = summary.metrics.tokens;
  if (!tokens) return undefined;
  if (field === "input") return tokens.input;
  if (field === "output") return tokens.output;
  // Both sides or nothing: a half-observed pair reported as a "total" would be a fabricated number —
  // the Run drops out of the sample instead, visible as `sampled < count`.
  return tokens.input === undefined || tokens.output === undefined ? undefined : tokens.input + tokens.output;
};

/** Latest verdict per Run for the requested evaluator (and version, when given). */
function verdictsFor(query: MetricQuery, evaluations: readonly EvaluationResult[]): Map<string, boolean> {
  const latest = new Map<string, EvaluationResult>();
  for (const result of evaluations) {
    if (query.evaluator && result.evaluatorId !== query.evaluator.id) continue;
    if (query.evaluator?.version !== undefined && result.evaluatorVersion !== query.evaluator.version) continue;
    const prior = latest.get(result.runId);
    if (!prior || result.evaluatedAt >= prior.evaluatedAt) latest.set(result.runId, result);
  }
  return new Map([...latest].map(([runId, result]) => [runId, result.passed]));
}

interface Cell { value: number | null; sampled: number }

function cell(metric: MetricName, statistic: ScalarAggregation, rows: readonly RunSummary[], sample: (summary: RunSummary) => number | undefined): Cell {
  if (metric === "tool_failure_rate") {
    const calls = rows.reduce((sum, row) => sum + row.metrics.toolCalls, 0);
    const failures = rows.reduce((sum, row) => sum + row.metrics.toolFailures, 0);
    return { value: calls === 0 ? null : failures / calls, sampled: rows.filter((row) => row.metrics.toolCalls > 0).length };
  }
  const samples = rows.map(sample).filter((value): value is number => value !== undefined);
  if (samples.length === 0) return { value: null, sampled: 0 };
  const sum = samples.reduce((total, value) => total + value, 0);
  const value = statistic === "count" ? sum
    : statistic === "rate" || statistic === "avg" ? sum / samples.length
    : percentile([...samples].sort((a, b) => a - b), statistic === "p50" ? 0.5 : 0.95);
  return { value, sampled: samples.length };
}

export const bucketStart = (startedAt: string, bucket: "hour" | "day"): string =>
  bucket === "hour" ? startedAt.slice(0, 13) + ":00:00.000Z" : startedAt.slice(0, 10) + "T00:00:00.000Z";

/**
 * Pure and deterministic: applies the effective window itself (the same predicates, byte for byte, as
 * `RunSummaryStore.query`, so calling it on pre-filtered store rows is idempotent), then aggregates.
 * The #172 reliability/compare endpoints are sugar over this function. For `task_completion`, pass the
 * evaluator's current results; a version-less evaluator matches its latest result per Run.
 */
export function computeMetric(query: MetricQuery, summaries: readonly RunSummary[], evaluations: readonly EvaluationResult[] = []): MetricResult {
  const { kind } = METRIC_CATALOGUE[query.metric];
  const { filter, lastRuns } = effectiveWindow(query);
  const window = summaries
    .filter((s) => (!filter.agentId || s.agentId === filter.agentId) && (!filter.configHash || s.configHash === filter.configHash)
      && (!filter.executionStatus || s.executionStatus === filter.executionStatus) && (!filter.taskOutcome || s.taskOutcome === filter.taskOutcome)
      && (!filter.from || (s.startedAt ?? "") >= filter.from) && (!filter.to || (s.startedAt ?? "") <= filter.to))
    .sort((a, b) => (b.startedAt ?? b.updatedAt).localeCompare(a.startedAt ?? a.updatedAt) || a.runId.localeCompare(b.runId))
    .slice(0, lastRuns ?? Number.POSITIVE_INFINITY);

  const verdicts = query.metric === "task_completion" ? verdictsFor(query, evaluations) : undefined;
  const sample = (s: RunSummary): number | undefined => {
    switch (query.metric) {
      case "execution_completion": return s.executionStatus === "running" ? undefined : s.executionStatus === "completed" ? 1 : 0;
      case "tool_calls": return s.metrics.toolCalls;
      case "tool_failures": return s.metrics.toolFailures;
      case "tokens": return tokensOf(s, query.tokens?.field ?? "total");
      case "latency": return s.durationMs;
      case "denials": return s.denials;
      case "estimated_cost_usd": return s.estimatedCostUsd;
      case "task_completion": { const passed = verdicts?.get(s.runId); return passed === undefined ? undefined : passed ? 1 : 0; }
      case "tool_failure_rate": return undefined; // aggregated pairwise in cell(), never per-run
    }
  };

  const aggregation = query.aggregation;
  let value: number | null | SeriesPoint[];
  let sampled: number;
  if (aggregation.type === "series") {
    const buckets = new Map<string, RunSummary[]>();
    for (const s of window) {
      if (!s.startedAt) continue; // no observed start time → no bucket to claim
      const key = bucketStart(s.startedAt, aggregation.bucket);
      const rows = buckets.get(key);
      if (rows) rows.push(s); else buckets.set(key, [s]);
    }
    const points = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, rows]) => {
      const c = cell(query.metric, aggregation.statistic, rows, sample);
      return { bucket, value: c.value, count: rows.length, sampled: c.sampled };
    });
    value = points;
    sampled = points.reduce((total, point) => total + point.sampled, 0);
  } else {
    const c = cell(query.metric, aggregation.type, window, sample);
    value = c.value;
    sampled = c.sampled;
  }

  const provenance: MetricProvenance = {
    count: window.length,
    sampled,
    ...(window.length <= PROVENANCE_RUN_ID_CAP ? { runIds: window.map((s) => s.runId) } : {}),
    filter: { ...filter, ...(lastRuns !== undefined ? { lastRuns } : {}) },
    ...(query.metric === "task_completion" && query.evaluator ? {
      evaluatorId: query.evaluator.id,
      ...(query.evaluator.version !== undefined ? { version: query.evaluator.version } : {}),
      evaluated: window.filter((s) => verdicts?.has(s.runId)).length,
    } : {}),
  };
  return { schemaVersion: SCHEMA_VERSION, metric: query.metric, kind, aggregation, value, provenance };
}

/**
 * Read facade over the two stores (FR-23): objective metrics from `RunSummaryStore`, `task_completion` from
 * `EvaluationStore`. No persistence of its own — backend-agnostic because it only touches the interfaces.
 */
export class MetricStore {
  constructor(private readonly summaries: RunSummaryStore, private readonly evaluations: EvaluationStore) {}

  async query(input: MetricQuery): Promise<MetricResult> {
    let query = input;
    let results: EvaluationResult[] = [];
    if (input.metric === "task_completion") {
      const requested = input.evaluator;
      if (!requested) throw new HttpError(400, `"task_completion" requires evaluator { id, version? }`);
      const definition = await this.evaluations.getDefinition(requested.id, requested.version);
      if (!definition) throw new HttpError(400, `Unknown evaluator "${requested.id}${requested.version !== undefined ? `@${requested.version}` : ""}"`);
      query = { ...input, evaluator: { id: definition.id, version: definition.version } };
      results = await this.evaluations.query({ evaluatorId: definition.id, version: definition.version });
    }
    const { filter, lastRuns } = effectiveWindow(query);
    const rows = await this.summaries.query({ ...filter, ...(lastRuns !== undefined ? { limit: lastRuns } : {}) });
    return computeMetric(query, rows, results);
  }
}
