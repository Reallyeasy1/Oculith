import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { EvaluationFields, EvaluationStore, EvaluatorDefinition } from "./evaluation.js";
import { redactText } from "./redact.js";
import type { ExecutionStatus, RunSummary, RunSummaryStore } from "./summary.js";

export type EvaluationJobStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

/** Only terminal Runs are ever evaluated; the worker drops `running` summaries regardless of the filter. */
export interface EvaluationJobFilter {
  agentId?: string | undefined;
  configHash?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  executionStatus?: ExecutionStatus | undefined;
}

export interface EvaluationJobFailure {
  runId: string;
  error: string;
}

/**
 * Historical evaluation over stored Run summaries (#170). Progress fields are persisted per Run so a
 * restart loses nothing: `initialize()` marks `running` jobs `interrupted` (like Runs), and resume
 * re-selects only the Runs that still have no stored result. A failing Run is provenance, not a job
 * failure — `failed` is reserved for a job that could not run at all.
 */
export interface EvaluationJob {
  id: string;
  evaluatorId: string;
  evaluatorVersion: number;
  filter: EvaluationJobFilter;
  status: EvaluationJobStatus;
  force: boolean;
  /** Model-call concurrency within the job, clamped to 1..2; across jobs the worker is strictly serial. */
  concurrency: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  /** Per-Run provenance of failures, bounded; `lastError` mirrors the most recent entry. */
  failures: EvaluationJobFailure[];
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface EvaluationJobInput {
  evaluatorId: string;
  evaluatorVersion?: number | undefined;
  filter?: EvaluationJobFilter | undefined;
  force?: boolean | undefined;
  concurrency?: number | undefined;
}

export interface EvaluationJobStore {
  create(job: EvaluationJob): Promise<EvaluationJob>;
  get(id: string): Promise<EvaluationJob | undefined>;
  /** Newest `createdAt` first. */
  list(): Promise<EvaluationJob[]>;
  update(id: string, mutation: (job: EvaluationJob) => void): Promise<EvaluationJob>;
  /** Restart honesty: every `running` job becomes `interrupted` — its worker no longer exists. */
  markInterrupted(reason: string): Promise<void>;
}

export class JsonEvaluationJobStore implements EvaluationJobStore {
  constructor(private readonly store: JsonStore) {}

  async create(job: EvaluationJob): Promise<EvaluationJob> {
    await this.store.mutate((database) => { database.evaluationJobs.push(structuredClone(job)); });
    return structuredClone(job);
  }

  async get(id: string): Promise<EvaluationJob | undefined> {
    return this.store.snapshot().evaluationJobs.find((job) => job.id === id);
  }

  async list(): Promise<EvaluationJob[]> {
    return this.store.snapshot().evaluationJobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async update(id: string, mutation: (job: EvaluationJob) => void): Promise<EvaluationJob> {
    return this.store.mutate((database) => {
      const job = database.evaluationJobs.find((item) => item.id === id);
      if (!job) throw new HttpError(404, "Evaluation job not found");
      mutation(job);
      return structuredClone(job);
    });
  }

  async markInterrupted(reason: string): Promise<void> {
    await this.store.mutate((database) => {
      for (const job of database.evaluationJobs) {
        if (job.status !== "running") continue;
        job.status = "interrupted";
        job.lastError = reason;
      }
    });
  }
}

/** What an evaluator observed about one Run; the worker adds identity, timestamps and jobId. */
export interface RunEvaluation {
  score?: number | undefined;
  passed: boolean;
  explanation: string;
  evidenceEventIds: string[];
  evaluatorModel?: string | undefined;
  metadata?: EvaluationFields | undefined;
}

/** The runtime seam: #171's LLM judge registers here; jobs for evaluators without a runtime are refused. */
export interface RunEvaluator {
  evaluate(summary: RunSummary, definition: EvaluatorDefinition): Promise<RunEvaluation>;
}

export type RunEvaluatorRegistry = ReadonlyMap<string, RunEvaluator>;

/** Deterministic, LLM-free: compares the stored terminal status with `config.expected` (default `completed`). */
export const terminalStatusEvaluator: RunEvaluator = {
  async evaluate(summary, definition) {
    const configured = definition.config["expected"];
    const expected = typeof configured === "string" ? configured : "completed";
    const passed = summary.executionStatus === expected;
    return {
      score: passed ? definition.maxScore : definition.minScore,
      passed,
      explanation: `Observed executionStatus "${summary.executionStatus}"; expected "${expected}".`,
      evidenceEventIds: [],
      metadata: { observed: summary.executionStatus, expected },
    };
  },
};

export const builtinRunEvaluators = (
  taskCompletion?: RunEvaluator | undefined,
  safety?: RunEvaluator | undefined,
  recoveryQuality?: RunEvaluator | undefined,
): RunEvaluatorRegistry =>
  new Map([
    ["terminal_status", terminalStatusEvaluator],
    ...(taskCompletion ? [["task_completion", taskCompletion] as const] : []),
    ...(safety ? [["safety", safety] as const] : []),
    ...(recoveryQuality ? [["recovery_quality", recoveryQuality] as const] : []),
  ]);

export interface EvaluationJobWorkerDeps {
  jobs: EvaluationJobStore;
  summaries: RunSummaryStore;
  evaluations: EvaluationStore;
  evaluators: RunEvaluatorRegistry;
  log?: ((message: string, meta: Record<string, unknown>) => void) | undefined;
  /** Injectable for tests; production waits in real time between provider retries. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  retry?: { attempts: number; baseDelayMs: number } | undefined;
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 200 };
const MAX_STORED_FAILURES = 25;
const MAX_ERROR_CHARS = 300;
const MAX_EVIDENCE_IDS = 50;
// Evidence must reference stored events (schema `id`: ≤128 chars, `evt_…` shape). An evaluator —
// #171's judge included — cannot smuggle free text through this field: non-conforming ids are dropped.
const EVIDENCE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const now = (): string => new Date().toISOString();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Errors can quote provider payloads; the same fail-closed rule as every other persisted surface. */
const safeError = (error: unknown): string => {
  try {
    return redactText(String(error instanceof Error ? error.message : error)).text.slice(0, MAX_ERROR_CHARS);
  } catch {
    return "[REDACTED:failed_closed]";
  }
};

/**
 * In-process background worker: one drain loop, strictly one job at a time, entirely off the Agent
 * execution path (its writes go through the same serialised `JsonStore.mutate` queue as everything
 * else, one small mutation per Run). It reads trace-derived summaries and writes results through
 * `EvaluationStore.putResult` (which redacts and owns `taskOutcome`) — it never touches trace evidence.
 */
export class EvaluationJobWorker {
  private processing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: EvaluationJobWorkerDeps) {}

  /** Boot-time restart honesty; queued jobs stay queued and `start()` picks them up. */
  async initialize(): Promise<void> {
    await this.deps.jobs.markInterrupted("Interrupted by server restart");
  }

  start(): void {
    this.kick();
  }

  /** Stops picking Runs; a job caught mid-flight is marked `interrupted` exactly like a restart. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * #192: user-defined llm_judge definitions have no per-id runtime — they all share the
   * task_completion judge, which frames its prompt and score bounds from the definition it is handed.
   */
  private runtimeFor(definition: EvaluatorDefinition): RunEvaluator | undefined {
    return this.deps.evaluators.get(definition.id)
      ?? (definition.type === "llm_judge" ? this.deps.evaluators.get("task_completion") : undefined);
  }

  async enqueue(input: EvaluationJobInput): Promise<EvaluationJob> {
    const definition = await this.deps.evaluations.getDefinition(input.evaluatorId, input.evaluatorVersion);
    if (!definition) throw new HttpError(404, "Evaluator definition not found");
    if (!this.runtimeFor(definition)) {
      throw new HttpError(501, `Evaluator "${definition.id}" has no registered runtime implementation`);
    }
    const job: EvaluationJob = {
      id: randomUUID(),
      evaluatorId: definition.id,
      evaluatorVersion: definition.version,
      filter: { ...input.filter },
      status: "queued",
      force: input.force ?? false,
      concurrency: Math.min(Math.max(input.concurrency ?? 1, 1), 2),
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      failures: [],
      createdAt: now(),
    };
    await this.deps.jobs.create(job);
    this.kick();
    return job;
  }

  async resume(id: string): Promise<EvaluationJob> {
    const job = await this.getOrThrow(id);
    if (job.status !== "interrupted" && job.status !== "failed") {
      throw new HttpError(409, `Only interrupted or failed jobs can be resumed (job is ${job.status})`);
    }
    const requeued = await this.deps.jobs.update(id, (item) => {
      item.status = "queued";
      item.lastError = undefined;
      item.completedAt = undefined;
    });
    this.kick();
    return requeued;
  }

  async list(): Promise<EvaluationJob[]> {
    return this.deps.jobs.list();
  }

  async getOrThrow(id: string): Promise<EvaluationJob> {
    const job = await this.deps.jobs.get(id);
    if (!job) throw new HttpError(404, "Evaluation job not found");
    return job;
  }

  /** Serialises drains through one promise chain: no flag races, redundant drains exit immediately. */
  private kick(): void {
    this.processing = this.processing.then(() => this.drain()).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    let storeFailures = 0;
    while (!this.stopped) {
      const next = (await this.deps.jobs.list())
        .filter((job) => job.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!next) return;
      try {
        await this.process(next.id);
        storeFailures = 0;
      } catch (error) {
        const message = safeError(error);
        const marked = await this.deps.jobs
          .update(next.id, (job) => { job.status = "failed"; job.completedAt = now(); job.lastError = message; })
          .then(() => true, () => false);
        // When even marking the job failed cannot be written (disk full, EACCES) the job stays
        // `queued` and would be re-selected immediately — back off so a broken store cannot
        // hot-spin this loop against the same serialised write queue the Run path uses.
        if (!marked) await (this.deps.sleep ?? defaultSleep)(Math.min(30_000, 1_000 * 2 ** ++storeFailures));
        this.deps.log?.("evaluation_job.failed", { jobId: next.id, error: message });
      }
    }
  }

  private async process(jobId: string): Promise<void> {
    const job = await this.getOrThrow(jobId);
    const definition = await this.deps.evaluations.getDefinition(job.evaluatorId, job.evaluatorVersion);
    if (!definition) throw new Error(`Evaluator definition ${job.evaluatorId}@${job.evaluatorVersion} no longer exists`);
    const evaluator = this.runtimeFor(definition);
    if (!evaluator) throw new Error(`Evaluator "${definition.id}" has no registered runtime implementation`);

    // Selection is recomputed on every (re)start, so progress is derived from stored results and can
    // never drift: previously failed Runs simply reappear as pending. `running` Runs are never candidates.
    const candidates = (await this.deps.summaries.query({ ...job.filter })).filter((s) => s.executionStatus !== "running");
    const existing = await this.deps.evaluations.query({ evaluatorId: definition.id, version: definition.version });
    const done = new Set(existing.filter((r) => (job.force ? r.jobId === job.id : true)).map((r) => r.runId));
    const pending = candidates.filter((s) => !done.has(s.runId));
    await this.deps.jobs.update(jobId, (item) => {
      item.status = "running";
      item.startedAt = item.startedAt ?? now();
      item.totalRuns = candidates.length;
      item.completedRuns = candidates.length - pending.length;
      item.failedRuns = 0;
      item.failures = [];
    });

    let index = 0;
    const width = Math.max(1, Math.min(job.concurrency, 2, pending.length));
    await Promise.all(Array.from({ length: width }, async () => {
      while (!this.stopped) {
        const i = index++;
        const summary = pending[i];
        if (!summary) return;
        await this.evaluateRun(jobId, definition, evaluator, summary);
      }
    }));

    await this.deps.jobs.update(jobId, (item) => {
      if (item.completedRuns + item.failedRuns < item.totalRuns) {
        item.status = "interrupted";
        item.lastError = "Interrupted by shutdown";
      } else {
        item.status = "completed";
        item.completedAt = now();
      }
    });
  }

  /** Provider backoff: retries the evaluator only; a store rejection (e.g. score out of range) fails the Run once. */
  private async evaluateRun(
    jobId: string,
    definition: EvaluatorDefinition,
    evaluator: RunEvaluator,
    summary: RunSummary,
  ): Promise<void> {
    const { attempts, baseDelayMs } = this.deps.retry ?? DEFAULT_RETRY;
    const sleep = this.deps.sleep ?? defaultSleep;
    let evaluation: RunEvaluation | undefined;
    let failure: unknown;
    for (let attempt = 0; attempt < attempts && evaluation === undefined; attempt++) {
      try {
        evaluation = await evaluator.evaluate(summary, definition);
      } catch (error) {
        failure = error;
        if (attempt + 1 < attempts) await sleep(baseDelayMs * 2 ** attempt);
      }
    }
    try {
      if (evaluation === undefined) throw failure;
      await this.deps.evaluations.putResult({
        runId: summary.runId,
        evaluatorId: definition.id,
        evaluatorVersion: definition.version,
        score: evaluation.score,
        passed: evaluation.passed,
        explanation: evaluation.explanation,
        evidenceEventIds: evaluation.evidenceEventIds.filter((id) => EVIDENCE_ID.test(id)).slice(0, MAX_EVIDENCE_IDS),
        evaluatorModel: evaluation.evaluatorModel,
        metadata: evaluation.metadata ?? {},
        evaluatedAt: now(),
        jobId,
      });
      await this.deps.jobs.update(jobId, (job) => { job.completedRuns += 1; });
    } catch (error) {
      const message = safeError(error);
      await this.deps.jobs.update(jobId, (job) => {
        job.failedRuns += 1;
        job.lastError = message;
        if (job.failures.length < MAX_STORED_FAILURES) job.failures.push({ runId: summary.runId, error: message });
      });
    }
  }
}
