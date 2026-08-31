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
 *
 * #384: each series point additionally carries `judgeScores` — per-bucket mean 1–5 scores from every
 * `llm_judge` evaluator version with stored results — on the evaluation side of the same line.
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

/** One scored, current `llm_judge` result for a Run — evaluator judgement provenance, never telemetry. */
export interface JudgeScoreSample { evaluatorId: string; version: number; score: number }

/**
 * #384: per-bucket judge aggregate — `meanScore` is the arithmetic mean of the stored 1–5 scores from
 * exactly this evaluator version, `evaluated` the count contributing. Derived ONLY from stored
 * evaluation results (a score-less verdict, e.g. recovery_quality's notEligible, joins no side);
 * no LLM call happens anywhere on this path.
 */
export interface JudgeScore { evaluatorId: string; version: number; evaluated: number; meanScore: number }

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
 * - `cost` (#369): USD over Runs with a persisted `estimatedCostUsd` (`sampled` counts them); a Run
 *   without a cost estimate joins no side — the sum is only over observed estimates, never a total claim.
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
  cost: { avg: number | null; sum: number | null; sampled: number };
}

/** `judgeScores` (#384) sits beside — never inside — the telemetry numbers: judgement provenance stays labelled. */
export interface ReliabilitySeriesPoint extends ReliabilityNumbers { bucket: string; judgeScores: JudgeScore[] }

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

/** #369: the agent-optional GET /api/reliability variant — one block over every Agent's Runs. */
export interface ReliabilityOverviewReport extends ReliabilityBlock {
  schemaVersion: typeof SCHEMA_VERSION;
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
  cost: { avg: number | null; sum: number | null };
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
  const costs = rows.map((row) => row.estimatedCostUsd).filter(observed);
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
    cost: { avg: ratio(sum(costs), costs.length), sum: costs.length === 0 ? null : sum(costs), sampled: costs.length },
  };
}

/** #384: one `JudgeScore` per evaluator version with ≥1 scored result among `rows`; `[]` otherwise. */
function judgeScoresFor(rows: readonly RunSummary[], samples: ReadonlyMap<string, readonly JudgeScoreSample[]>): JudgeScore[] {
  const totals = new Map<string, { evaluatorId: string; version: number; evaluated: number; total: number }>();
  for (const row of rows) {
    for (const sample of samples.get(row.runId) ?? []) {
      const key = `${sample.evaluatorId}\0${sample.version}`;
      const entry = totals.get(key) ?? { evaluatorId: sample.evaluatorId, version: sample.version, evaluated: 0, total: 0 };
      entry.evaluated += 1;
      entry.total += sample.score;
      totals.set(key, entry);
    }
  }
  return [...totals.values()].sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId) || a.version - b.version)
    .map(({ evaluatorId, version, evaluated, total }) => ({ evaluatorId, version, evaluated, meanScore: total / evaluated }));
}

/** Numbers + a UTC hour/day series (a Run without an observed start time joins no bucket) + provenance. */
export function buildReliabilityBlock(rows: readonly RunSummary[], verdicts: ReadonlyMap<string, boolean>, evaluator: EvaluatorRef, bucket: "hour" | "day", filter: ReliabilityFilter, judgeSamples: ReadonlyMap<string, readonly JudgeScoreSample[]>): ReliabilityBlock {
  const buckets = new Map<string, RunSummary[]>();
  for (const row of rows) {
    if (!row.startedAt) continue;
    const key = bucketStart(row.startedAt, bucket);
    const bucketRows = buckets.get(key);
    if (bucketRows) bucketRows.push(row); else buckets.set(key, [row]);
  }
  const series = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucketRows]) => ({ bucket: key, ...reliabilityNumbers(bucketRows, verdicts, evaluator), judgeScores: judgeScoresFor(bucketRows, judgeSamples) }));
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
    cost: { avg: diff(a.cost.avg, b.cost.avg), sum: diff(a.cost.sum, b.cost.sum) },
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

  /**
   * One pass over the store's current results: the pinned evaluator's latest verdict per Run, plus
   * (#384) runId → every current *scored* `llm_judge` result across all judge evaluator versions.
   * Reads only what the store already holds — a score-less verdict (e.g. notEligible) contributes
   * nothing — and shares a single `query()` so the 1,000-summary perf bound keeps holding.
   */
  private async evaluationSlices(evaluator: EvaluatorRef): Promise<{ verdicts: Map<string, boolean>; judgeSamples: Map<string, JudgeScoreSample[]> }> {
    const definitions = await this.evaluations.listDefinitions();
    const judges = new Set(definitions.filter((definition) => definition.type === "llm_judge").map((definition) => `${definition.id}\0${definition.version}`));
    const verdicts = new Map<string, boolean>();
    const judgeSamples = new Map<string, JudgeScoreSample[]>();
    for (const result of await this.evaluations.query()) {
      if (result.evaluatorId === evaluator.id && result.evaluatorVersion === evaluator.version) verdicts.set(result.runId, result.passed);
      if (result.score === undefined || !judges.has(`${result.evaluatorId}\0${result.evaluatorVersion}`)) continue;
      const sample: JudgeScoreSample = { evaluatorId: result.evaluatorId, version: result.evaluatorVersion, score: result.score };
      const existing = judgeSamples.get(result.runId);
      if (existing) existing.push(sample); else judgeSamples.set(result.runId, [sample]);
    }
    return { verdicts, judgeSamples };
  }

  async forAgent(agentId: string, query: ReliabilityQuery): Promise<ReliabilityReport> {
    const evaluator = await this.resolveEvaluator(query.evaluatorId, query.evaluatorVersion);
    const { verdicts, judgeSamples } = await this.evaluationSlices(evaluator);
    const filter: ReliabilityFilter = {
      agentId,
      ...(query.configHash !== undefined ? { configHash: query.configHash } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    };
    const rows = await this.summaries.query(filter);
    return { schemaVersion: SCHEMA_VERSION, agentId, ...buildReliabilityBlock(rows, verdicts, evaluator, query.bucket, filter, judgeSamples) };
  }

  /** #369: same window semantics with no Agent bound — `ReliabilityFilter.agentId` simply stays unset. */
  async forAll(query: ReliabilityQuery): Promise<ReliabilityOverviewReport> {
    const evaluator = await this.resolveEvaluator(query.evaluatorId, query.evaluatorVersion);
    const { verdicts, judgeSamples } = await this.evaluationSlices(evaluator);
    const filter: ReliabilityFilter = {
      ...(query.configHash !== undefined ? { configHash: query.configHash } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    };
    const rows = await this.summaries.query(filter);
    return { schemaVersion: SCHEMA_VERSION, ...buildReliabilityBlock(rows, verdicts, evaluator, query.bucket, filter, judgeSamples) };
  }

  async compare(query: ReliabilityCompareQuery): Promise<ReliabilityCompareReport> {
    const evaluator = await this.resolveEvaluator(query.evaluatorId, query.evaluatorVersion);
    const { verdicts, judgeSamples } = await this.evaluationSlices(evaluator);
    const side = async (configHash: string): Promise<ReliabilityBlock & { configHash: string }> => {
      const filter: ReliabilityFilter = {
        agentId: query.agentId, configHash,
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
      };
      const rows = await this.summaries.query(filter);
      return { configHash, ...buildReliabilityBlock(rows, verdicts, evaluator, query.bucket, filter, judgeSamples) };
    };
    const a = await side(query.a);
    const b = await side(query.b);
    return { schemaVersion: SCHEMA_VERSION, agentId: query.agentId, a, b, deltas: reliabilityDeltas(a, b) };
  }
}
