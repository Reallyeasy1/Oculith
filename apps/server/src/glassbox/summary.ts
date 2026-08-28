import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { ObservationEmitter } from "./emitter.js";
import { buildTrace, type TraceMetrics, type TraceSummary, type TraceView } from "./query.js";
import type { CapturePolicy, TraceStatus } from "./schema.js";
import type { RunIndexEntry, TraceStore } from "./store.js";

/** Bump when `summaryFromView` changes shape or meaning; `npm run glassbox:backfill` then rewrites older records. */
export const ROLLUP_VERSION = 6; // 6: metrics.timeSplit / timeToFirstToolMs (#129)

export type ExecutionStatus = "running" | "completed" | "failed" | "timeout" | "cancelled";
export type TaskOutcome = "passed" | "failed" | "unknown";

const EXECUTION_STATUS: Record<TraceStatus, ExecutionStatus> = { running: "running", unset: "running", ok: "completed", error: "failed", timeout: "timeout", cancelled: "cancelled" };
const TRACE_STATUS: Record<ExecutionStatus, TraceStatus> = { running: "running", completed: "ok", failed: "error", timeout: "timeout", cancelled: "cancelled" };
export const executionStatusOf = (status: TraceStatus): ExecutionStatus => EXECUTION_STATUS[status];
export const traceStatusOf = (status: ExecutionStatus): TraceStatus => TRACE_STATUS[status];

/**
 * Persisted per-Run rollup: `buildTrace(events).summary` + the outcome fields, written once at Run end so listing
 * and aggregation never re-read NDJSON. `executionStatus` is the process status; `taskOutcome` says whether the
 * task succeeded and is set only by the evaluation plane or the Agent's post-run verify command (#253) — never by events; `unknown` until then.
 */
export interface RunSummary {
  runId: string; traceId: string; agentId: string; configHash?: string | undefined; capturePolicy: CapturePolicy;
  executionStatus: ExecutionStatus; taskOutcome: TaskOutcome;
  /** `evaluator:<id>@<version>` | `deterministic:<evalRunId>` | `post_check` (#253); absent while `taskOutcome` is `unknown`. */
  taskOutcomeSource?: string | undefined;
  startedAt?: string | undefined; endedAt?: string | undefined; durationMs?: number | undefined; lastEventAt?: string | undefined;
  workspace?: string | undefined; sessionId?: string | undefined;
  metrics: TraceMetrics; usage?: TraceSummary["usage"]; denials: number; actions: number;
  capabilities: TraceSummary["capabilities"]; workspaceChanges?: TraceSummary["workspaceChanges"];
  /** #132 — `text` is an observed fact (the agent's own final words, safe_summary only); `reportedFailure` is a derived phrase match. Neither is `taskOutcome`. */
  outcome?: TraceSummary["outcome"];
  degraded: boolean; truncated: boolean; evicted: boolean; redactedEvents: number; eventCount: number;
  firstFailingStep?: string | undefined; endedReason?: TraceSummary["endedReason"]; interruptedAfterMs?: number | undefined;
  rollupVersion: number; updatedAt: string;
}

export interface RunSummaryQuery {
  agentId?: string | undefined; configHash?: string | undefined;
  /** Inclusive bounds on `startedAt`. */
  from?: string | undefined; to?: string | undefined;
  executionStatus?: ExecutionStatus | undefined; taskOutcome?: TaskOutcome | undefined; limit?: number | undefined;
}

/**
 * Contract shared by every backend: `upsert` owns the rollup fields only and never overwrites `taskOutcome` /
 * `taskOutcomeSource` on an existing row (the evaluation plane writes those through `setTaskOutcome`, which
 * may race a rollup); it returns the row as stored. `setTaskOutcome` needs the row to exist — a caller that
 * finishes before the terminal event was rolled up should `await rollupRun(...)` first (it is idempotent).
 */
export interface RunSummaryStore {
  upsert(summary: RunSummary): Promise<RunSummary>;
  get(runId: string): Promise<RunSummary | undefined>;
  /** Newest `startedAt` first. */
  query(query?: RunSummaryQuery): Promise<RunSummary[]>;
  setTaskOutcome(runId: string, outcome: TaskOutcome, source: string): Promise<void>;
  /** Releases connections; the JSON backend has nothing to release. */
  close?(): Promise<void>;
}

/** The single derivation: every field comes from the view so the summary and the trace endpoint can never disagree. */
export function summaryFromView(view: TraceView, extra: { taskOutcome?: TaskOutcome | undefined; taskOutcomeSource?: string | undefined; updatedAt?: string | undefined } = {}): RunSummary {
  const s = view.summary;
  return {
    runId: s.runId, traceId: s.traceId, agentId: s.agentId, configHash: s.configHash, capturePolicy: s.capturePolicy,
    executionStatus: executionStatusOf(s.status), taskOutcome: extra.taskOutcome ?? "unknown", taskOutcomeSource: extra.taskOutcomeSource,
    startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs, lastEventAt: view.events.at(-1)?.timestamp,
    workspace: s.workspace, sessionId: s.sessionId,
    metrics: s.metrics, usage: s.usage, denials: s.denials, actions: s.audit.actions, capabilities: s.capabilities, workspaceChanges: s.workspaceChanges, outcome: s.outcome,
    degraded: s.degraded, truncated: s.truncated, evicted: s.evicted, redactedEvents: s.redactedEvents, eventCount: s.eventCount,
    firstFailingStep: s.firstFailingStep, endedReason: s.endedReason, interruptedAfterMs: s.interruptedAfterMs,
    rollupVersion: ROLLUP_VERSION, updatedAt: extra.updatedAt ?? new Date().toISOString(),
  };
}

/** A stored summary is current when it was built by this rollup and has seen every event the index has. */
export const isFresh = (summary: RunSummary | undefined, entry: RunIndexEntry): summary is RunSummary =>
  summary !== undefined && summary.rollupVersion === ROLLUP_VERSION && summary.executionStatus !== "running" && summary.eventCount === entry.eventCount;

export class JsonRunSummaryStore implements RunSummaryStore {
  constructor(private readonly store: JsonStore) {}

  async get(runId: string): Promise<RunSummary | undefined> {
    return this.store.snapshot().runSummaries.find((s) => s.runId === runId);
  }

  async query(q: RunSummaryQuery = {}): Promise<RunSummary[]> {
    return this.store.snapshot().runSummaries
      .filter((s) => (!q.agentId || s.agentId === q.agentId) && (!q.configHash || s.configHash === q.configHash)
        && (!q.executionStatus || s.executionStatus === q.executionStatus) && (!q.taskOutcome || s.taskOutcome === q.taskOutcome)
        && (!q.from || (s.startedAt ?? "") >= q.from) && (!q.to || (s.startedAt ?? "") <= q.to))
      // runId tie-break so a `limit` window is deterministic across identical queries (and backends)
      .sort((a, b) => (b.startedAt ?? b.updatedAt).localeCompare(a.startedAt ?? a.updatedAt) || a.runId.localeCompare(b.runId))
      .slice(0, q.limit ?? Number.POSITIVE_INFINITY);
  }

  async upsert(summary: RunSummary): Promise<RunSummary> {
    let stored = summary;
    await this.store.mutate((db) => {
      const i = db.runSummaries.findIndex((s) => s.runId === summary.runId);
      const previous = db.runSummaries[i];
      stored = previous ? { ...summary, taskOutcome: previous.taskOutcome, taskOutcomeSource: previous.taskOutcomeSource } : summary;
      if (i >= 0) db.runSummaries[i] = stored; else db.runSummaries.push(stored);
    });
    return stored;
  }

  async setTaskOutcome(runId: string, outcome: TaskOutcome, source: string): Promise<void> {
    await this.store.mutate((db) => {
      const s = db.runSummaries.find((item) => item.runId === runId);
      if (!s) throw new HttpError(404, "Run summary not found");
      s.taskOutcome = outcome; s.taskOutcomeSource = source; s.updatedAt = new Date().toISOString();
    });
  }
}

export interface RollupDeps {
  traces: TraceStore; emitter: ObservationEmitter; summaries: RunSummaryStore;
  log?: ((message: string, meta: Record<string, unknown>) => void) | undefined;
}

/** Reads the trace, derives the summary and stores it; the store keeps an outcome the evaluation plane already wrote. */
export async function rollupRun(deps: RollupDeps, runId: string, entry?: RunIndexEntry | undefined): Promise<RunSummary | undefined> {
  const events = await deps.traces.readRun(runId);
  if (events.length === 0) return undefined;
  const found = entry ?? deps.traces.listRuns().find((e) => e.runId === runId);
  const view = buildTrace(events, { capturePolicy: deps.emitter.capturePolicy, degraded: deps.emitter.isDegraded(runId), truncated: found?.truncated });
  return deps.summaries.upsert(summaryFromView(view));
}

/** Write path (invariant 3): waits for the terminal event to land, then rolls up; a failure is logged, never raised.
 * `outcome` (#253: the Agent's verifyCommand verdict) is stamped after the row exists, like the eval path does. */
export function scheduleRollup(deps: RollupDeps, runId: string, outcome?: { taskOutcome: TaskOutcome; source: string } | undefined): Promise<void> {
  return deps.emitter.flush()
    .then(() => rollupRun(deps, runId))
    .then((summary) => (outcome && summary ? deps.summaries.setTaskOutcome(runId, outcome.taskOutcome, outcome.source) : undefined))
    .then(
      () => undefined,
      (error) => { deps.log?.("summary.rollup_failed", { runId, error: String(error).slice(0, 200) }); },
    );
}

/** Rolls up every finished Run in the trace index whose summary is missing or older than `ROLLUP_VERSION`. Idempotent. */
export async function backfillSummaries(deps: RollupDeps): Promise<{ scanned: number; written: number; skipped: number }> {
  const report = { scanned: 0, written: 0, skipped: 0 };
  for (const entry of deps.traces.listRuns()) {
    report.scanned++;
    const existing = await deps.summaries.get(entry.runId);
    // Running Runs are rolled up by their own terminal event; a stale count means events landed after the last rollup.
    if (entry.status === "running" || isFresh(existing, entry)) { report.skipped++; continue; }
    if (await rollupRun(deps, entry.runId, entry)) report.written++;
  }
  return report;
}
