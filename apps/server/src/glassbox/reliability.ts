import { z } from "zod";
import { HttpError } from "../errors.js";
import type { EvaluationStore } from "./evaluation.js";
import { bucketStart, isoDatetime, percentile, PROVENANCE_RUN_ID_CAP, tokensOf } from "./metrics.js";
import { SCHEMA_VERSION } from "./schema.js";
import type { RunSummary, RunSummaryStore } from "./summary.js";

/**
 * #172: historical reliability aggregates by Agent, configHash and time range — specific endpoints, no
 * query language. The two metric families stay distinct and labelled by field: objective telemetry
 * (`executionCompletionRate`, `toolFailureRate`, `avgToolCalls`, `tokens`, `latency`, `denialRate`) comes
 * from `RunSummary` rows, and the one evaluation metric (`taskCompletionRate`) comes from
 * `EvaluationResult`s and always carries its evaluator id + version as provenance. Every definition below
 * matches `computeMetric` (metrics.ts) byte for byte, so `/api/metrics/query` and these endpoints can
 * never disagree on the same window.
 */
export const reliabilityQuerySchema = z.strictObject({
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  configHash: z.string().min(1).max(64).optional(),
  bucket: z.enum(["hour", "day"]).default("day"),
  evaluatorId: z.string().min(1).max(200).default("task_completion"),
  evaluatorVersion: z.coerce.number().int().min(1).optional(),
});
export type ReliabilityQuery = z.infer<typeof reliabilityQuerySchema>;

export const reliabilityCompareQuerySchema = z.strictObject({
  agentId: z.string().uuid(),
  a: z.string().min(1).max(64),
  b: z.string().min(1).max(64),
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  bucket: z.enum(["hour", "day"]).default("day"),
  evaluatorId: z.string().min(1).max(200).default("task_completion"),
  evaluatorVersion: z.coerce.number().int().min(1).optional(),
});
export type ReliabilityCompareQuery = z.infer<typeof reliabilityCompareQuerySchema>;

export interface EvaluatorRef { id: string; version: number }

/**
 * `rate` = passed / evaluated. Unevaluated Runs are excluded from both sides — `evaluated` says how many
 * of the window's `runs` had a verdict from exactly this evaluator version, so the caller can tell a
 * confident 100 % (evaluated 40/40) from a hollow one (evaluated 1/40).
 */
export interface TaskCompletionRate {
  evaluatorId: string; version: number;
  evaluated: number; passed: number; rate: number | null;
}

/**
 * One aggregate block. Semantics (each `null` when nothing was observed — zero is a claim):
 * - `executionCompletionRate`: completed / terminal Runs; running Runs are on neither side.
 * - `toolFailureRate`: Σ toolFailures / Σ toolCalls (micro-average, same as `computeMetric`).
 * - `tokens.sum`: Σ (input + output) over Runs observing both sides (`sampled` counts them); a
 *   half-observed pair is never reported as a total. `avgInput`/`avgOutput` average each observed side.
 * - `latency`: nearest-rank percentiles over Runs with an observed `durationMs` (`sampled` counts them) —
 *   the returned value is always a duration some Run actually exhibited.
 * - `denialRate`: Runs with ≥ 1 denial / all window Runs.
 */
export interface ReliabilityNumbers {
  runs: number;
  executionCompletionRate: number | null;
  taskCompletionRate: TaskCompletionRate;
  toolFailureRate: number | null;
  avgToolCalls: number | null;
  tokens: { avgInput: number | null; avgOutput: number | null; sum: number | null; sampled: number };
  latency: { p50: number | null; p95: number | null; sampled: number };
  denialRate: number | null;
}

export interface ReliabilitySeriesPoint extends ReliabilityNumbers { bucket: string }

export interface ReliabilityFilter {
  agentId?: string | undefined; configHash?: string | undefined;
  from?: string | undefined; to?: string | undefined;
}

/** Same drill-back contract as `MetricProvenance`: runIds inline up to the cap, the filter echo always. */
export interface ReliabilityProvenance {
  count: number;
  runIds?: string[] | undefined;
  filter: ReliabilityFilter;
}

export interface ReliabilityBlock extends ReliabilityNumbers {
  series: ReliabilitySeriesPoint[];
  provenance: ReliabilityProvenance;
}

export interface ReliabilityReport extends ReliabilityBlock {
  schemaVersion: typeof SCHEMA_VERSION;
  agentId: string;
}

/** Per-number deltas, `b − a`; `null` whenever either side observed nothing (a delta from null is a guess). */
export interface ReliabilityDeltas {
  runs: number;
  executionCompletionRate: number | null;
  taskCompletionRate: number | null;
  toolFailureRate: number | null;
  avgToolCalls: number | null;
  tokens: { avgInput: number | null; avgOutput: number | null; sum: number | null };
  latency: { p50: number | null; p95: number | null };
  denialRate: number | null;
}

export interface ReliabilityCompareReport {
  schemaVersion: typeof SCHEMA_VERSION;
  agentId: string;
  a: ReliabilityBlock & { configHash: string };
  b: ReliabilityBlock & { configHash: string };
  deltas: ReliabilityDeltas;
}

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);
const observed = (value: number | undefined): value is number => value !== undefined;
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** The pure aggregation over an already-windowed set of rows; `verdicts` is runId → passed for one evaluator version. */
export function reliabilityNumbers(rows: readonly RunSummary[], verdicts: ReadonlyMap<string, boolean>, evaluator: EvaluatorRef): ReliabilityNumbers {
  const terminal = rows.filter((row) => row.executionStatus !== "running");
  const completed = terminal.filter((row) => row.executionStatus === "completed").length;
  const toolCalls = sum(rows.map((row) => row.metrics.toolCalls));
  const toolFailures = sum(rows.map((row) => row.metrics.toolFailures));
  const inputs = rows.map((row) => tokensOf(row, "input")).filter(observed);
  const outputs = rows.map((row) => tokensOf(row, "output")).filter(observed);
  const totals = rows.map((row) => tokensOf(row, "total")).filter(observed);
  const durations = rows.map((row) => row.durationMs).filter(observed).sort((a, b) => a - b);
  const evaluated = rows.filter((row) => verdicts.has(row.runId));
  const passed = evaluated.filter((row) => verdicts.get(row.runId)).length;
  const denied = rows.filter((row) => row.denials > 0).length;
  return {
    runs: rows.length,
    executionCompletionRate: ratio(completed, terminal.length),
    taskCompletionRate: { evaluatorId: evaluator.id, version: evaluator.version, evaluated: evaluated.length, passed, rate: ratio(passed, evaluated.length) },
    toolFailureRate: ratio(toolFailures, toolCalls),
    avgToolCalls: ratio(toolCalls, rows.length),
    tokens: { avgInput: ratio(sum(inputs), inputs.length), avgOutput: ratio(sum(outputs), outputs.length), sum: totals.length === 0 ? null : sum(totals), sampled: totals.length },
    latency: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), sampled: durations.length },
    denialRate: ratio(denied, rows.length),
  };
}

/** Numbers + a UTC hour/day series (a Run without an observed start time joins no bucket) + provenance. */
export function buildReliabilityBlock(rows: readonly RunSummary[], verdicts: ReadonlyMap<string, boolean>, evaluator: EvaluatorRef, bucket: "hour" | "day", filter: ReliabilityFilter): ReliabilityBlock {
  const buckets = new Map<string, RunSummary[]>();
  for (const row of rows) {
    if (!row.startedAt) continue;
    const key = bucketStart(row.startedAt, bucket);
    const bucketRows = buckets.get(key);
    if (bucketRows) bucketRows.push(row); else buckets.set(key, [row]);
  }
  const series = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucketRows]) => ({ bucket: key, ...reliabilityNumbers(bucketRows, verdicts, evaluator) }));
  return {
    ...reliabilityNumbers(rows, verdicts, evaluator),
    series,
    provenance: {
      count: rows.length,
      ...(rows.length <= PROVENANCE_RUN_ID_CAP ? { runIds: rows.map((row) => row.runId) } : {}),
      filter,
    },
  };
}

export function reliabilityDeltas(a: ReliabilityNumbers, b: ReliabilityNumbers): ReliabilityDeltas {
  const diff = (left: number | null, right: number | null): number | null => (left === null || right === null ? null : right - left);
  return {
    runs: b.runs - a.runs,
    executionCompletionRate: diff(a.executionCompletionRate, b.executionCompletionRate),
    taskCompletionRate: diff(a.taskCompletionRate.rate, b.taskCompletionRate.rate),
    toolFailureRate: diff(a.toolFailureRate, b.toolFailureRate),
    avgToolCalls: diff(a.avgToolCalls, b.avgToolCalls),
    tokens: { avgInput: diff(a.tokens.avgInput, b.tokens.avgInput), avgOutput: diff(a.tokens.avgOutput, b.tokens.avgOutput), sum: diff(a.tokens.sum, b.tokens.sum) },
    latency: { p50: diff(a.latency.p50, b.latency.p50), p95: diff(a.latency.p95, b.latency.p95) },
    denialRate: diff(a.denialRate, b.denialRate),
  };
}

/**
 * Read facade over the two stores, like `MetricStore` — no persistence, backend-agnostic. In-memory
 * aggregation over `RunSummaryStore.query` is the deliberate scale point (hundreds of Runs); the test
 * asserts the 500 ms bound on 1,000 synthetic summaries before any materialisation is worth its weight.
 */
export class ReliabilityService {
  constructor(private readonly summaries: RunSummaryStore, private readonly evaluations: EvaluationStore) {}

  /** Resolves id (+ optional version) to a concrete definition; a version-less request means "latest". */
  private async resolveEvaluator(id: string, version?: number | undefined): Promise<EvaluatorRef> {
    const definition = await this.evaluations.getDefinition(id, version);
    if (!definition) throw new HttpError(400, `Unknown evaluator "${id}${version !== undefined ? `@${version}` : ""}"`);
    return { id: definition.id, version: definition.version };
  }

  /** Latest verdict per Run for exactly one evaluator version (the store already exposes only current results). */
  private async verdicts(evaluator: EvaluatorRef): Promise<Map<string, boolean>> {
    const results = await this.evaluations.query({ evaluatorId: evaluator.id, version: evaluator.version });
    return new Map(results.map((result) => [result.runId, result.passed]));
  }

  async forAgent(agentId: string, query: ReliabilityQuery): Promise<ReliabilityReport> {
    const evaluator = await this.resolveEvaluator(query.evaluatorId, query.evaluatorVersion);
    const verdicts = await this.verdicts(evaluator);
    const filter: ReliabilityFilter = {
      agentId,
      ...(query.configHash !== undefined ? { configHash: query.configHash } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    };
    const rows = await this.summaries.query(filter);
    return { schemaVersion: SCHEMA_VERSION, agentId, ...buildReliabilityBlock(rows, verdicts, evaluator, query.bucket, filter) };
  }

  async compare(query: ReliabilityCompareQuery): Promise<ReliabilityCompareReport> {
    const evaluator = await this.resolveEvaluator(query.evaluatorId, query.evaluatorVersion);
    const verdicts = await this.verdicts(evaluator);
    const side = async (configHash: string): Promise<ReliabilityBlock & { configHash: string }> => {
      const filter: ReliabilityFilter = {
        agentId: query.agentId, configHash,
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
      };
      const rows = await this.summaries.query(filter);
      return { configHash, ...buildReliabilityBlock(rows, verdicts, evaluator, query.bucket, filter) };
    };
    const a = await side(query.a);
    const b = await side(query.b);
    return { schemaVersion: SCHEMA_VERSION, agentId: query.agentId, a, b, deltas: reliabilityDeltas(a, b) };
  }
}
