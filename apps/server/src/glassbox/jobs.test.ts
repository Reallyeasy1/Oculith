import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { JsonEvaluationStore } from "./evaluation.js";
import {
  builtinRunEvaluators,
  EvaluationJobWorker,
  JsonEvaluationJobStore,
  terminalStatusEvaluator,
  type EvaluationJob,
  type EvaluationJobStore,
  type RunEvaluator,
} from "./jobs.js";
import { buildTrace } from "./query.js";
import { JsonRunSummaryStore, summaryFromView, type ExecutionStatus } from "./summary.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const SECRET = "sk-proj-" + "A".repeat(24);

async function setup(evaluators: Map<string, RunEvaluator> = new Map()) {
  const dir = await mkdtemp(path.join(tmpdir(), "evaluation-jobs-"));
  dirs.push(dir);
  const file = path.join(dir, "launchpad.json");
  const json = new JsonStore(file);
  await json.initialize();
  const summaries = new JsonRunSummaryStore(json);
  const evaluations = new JsonEvaluationStore(json, summaries);
  await evaluations.initialize();
  const jobStore = new JsonEvaluationJobStore(json);
  const sleeps: number[] = [];
  const worker = new EvaluationJobWorker({
    jobs: jobStore, summaries, evaluations, evaluators,
    sleep: async (ms) => { sleeps.push(ms); },
    retry: { attempts: 3, baseDelayMs: 5 },
  });
  return { file, json, summaries, evaluations, jobStore, worker, sleeps };
}

async function addSummary(
  summaries: JsonRunSummaryStore,
  runId: string,
  agentId: string,
  startedAt: string,
  executionStatus: ExecutionStatus = "completed",
) {
  const base = summaryFromView(buildTrace([], { capturePolicy: "metadata_only" }));
  await summaries.upsert({ ...base, runId, traceId: "trace-" + runId, agentId, startedAt, executionStatus, eventCount: 1 });
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error("condition not met: " + JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const untilStatus = (jobStore: JsonEvaluationJobStore, id: string, status: EvaluationJob["status"]) =>
  until(async () => (await jobStore.get(id))!, (job) => job.status === status);

const passing = (calls?: string[]): RunEvaluator => ({
  async evaluate(summary) {
    calls?.push(summary.runId);
    return { score: 5, passed: true, explanation: "looks done", evidenceEventIds: ["evt-1"] };
  },
});

describe("EvaluationJobWorker", () => {
  it("evaluates matching terminal Runs, tolerating a failing Run with redacted per-Run provenance", async () => {
    const calls: string[] = [];
    const evaluator: RunEvaluator = {
      async evaluate(summary, definition) {
        calls.push(summary.runId);
        if (summary.runId === "run-3") throw new Error("provider rejected key " + SECRET);
        return { score: 5, passed: true, explanation: "done", evidenceEventIds: ["evt-1"], evaluatorModel: definition.model };
      },
    };
    const { file, summaries, evaluations, jobStore, worker, sleeps } = await setup(new Map([["task_completion", evaluator]]));
    for (let i = 1; i <= 5; i++) await addSummary(summaries, `run-${i}`, "agent-a", `2026-08-28T0${i}:00:00.000Z`);
    await addSummary(summaries, "run-other", "agent-b", "2026-08-28T06:00:00.000Z");
    await addSummary(summaries, "run-live", "agent-a", "2026-08-28T07:00:00.000Z", "running");

    const job = await worker.enqueue({ evaluatorId: "task_completion", filter: { agentId: "agent-a" } });
    expect(job.status).toBe("queued");
    const finished = await untilStatus(jobStore, job.id, "completed");

    expect(finished).toMatchObject({ totalRuns: 5, completedRuns: 4, failedRuns: 1 });
    expect(finished.failures).toHaveLength(1);
    expect(finished.failures[0]?.runId).toBe("run-3");
    // The failing Run was retried with backoff before it was recorded.
    expect(sleeps).toEqual([5, 10]);
    expect(calls.filter((id) => id === "run-3")).toHaveLength(3);
    // Never a candidate: another Agent's Run and a still-running Run.
    expect(calls).not.toContain("run-other");
    expect(calls).not.toContain("run-live");

    const results = await evaluations.resultsForRun("run-1");
    expect(results[0]).toMatchObject({ evaluatorId: "task_completion", evaluatorVersion: 1, passed: true, jobId: job.id });
    // task_completion sets the outcome through the store; the worker itself never touches summaries.
    expect(await summaries.get("run-1")).toMatchObject({ taskOutcome: "passed", taskOutcomeSource: "evaluator:task_completion@1" });
    // The provider error quoted a secret; nothing persisted may contain it.
    const persisted = await readFile(file, "utf8");
    expect(persisted).not.toContain(SECRET);
    expect(finished.lastError).not.toContain(SECRET);
  });

  it("skips Runs that already have a result for the evaluator version unless the job is forced", async () => {
    const calls: string[] = [];
    const { summaries, evaluations, jobStore, worker } = await setup(new Map([["task_completion", passing(calls)]]));
    await addSummary(summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    await addSummary(summaries, "run-2", "agent-a", "2026-08-28T02:00:00.000Z");
    await evaluations.putResult({ runId: "run-1", evaluatorId: "task_completion", evaluatorVersion: 1, score: 4, passed: true,
      explanation: "already evaluated", evidenceEventIds: [], metadata: {}, evaluatedAt: "2026-08-28T03:00:00.000Z" });

    const job = await worker.enqueue({ evaluatorId: "task_completion" });
    const finished = await untilStatus(jobStore, job.id, "completed");
    expect(finished).toMatchObject({ totalRuns: 2, completedRuns: 2, failedRuns: 0 });
    expect(calls).toEqual(["run-2"]);

    const forced = await worker.enqueue({ evaluatorId: "task_completion", force: true });
    const refreshed = await untilStatus(jobStore, forced.id, "completed");
    expect(refreshed).toMatchObject({ totalRuns: 2, completedRuns: 2 });
    expect(calls.slice(1).sort()).toEqual(["run-1", "run-2"]);
  });

  it("clamps per-job concurrency and keeps at most two evaluations in flight", async () => {
    let active = 0;
    let maxActive = 0;
    const evaluator: RunEvaluator = {
      async evaluate() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { passed: true, explanation: "ok", evidenceEventIds: [] };
      },
    };
    const { summaries, jobStore, worker } = await setup(new Map([["task_completion", evaluator]]));
    for (let i = 1; i <= 5; i++) await addSummary(summaries, `run-${i}`, "agent-a", `2026-08-28T0${i}:00:00.000Z`);

    const job = await worker.enqueue({ evaluatorId: "task_completion", concurrency: 9 });
    expect(job.concurrency).toBe(2);
    await untilStatus(jobStore, job.id, "completed");
    expect(maxActive).toBe(2);
  });

  it("marks running jobs interrupted at boot and resume evaluates only the remaining Runs", async () => {
    const first = await setup();
    let callCount = 0;
    const stallAfterOne: RunEvaluator = {
      evaluate: async () => {
        if (++callCount === 1) return { passed: true, explanation: "done", evidenceEventIds: [] };
        return new Promise(() => undefined); // the server "dies" mid-job
      },
    };
    const worker = new EvaluationJobWorker({ jobs: first.jobStore, summaries: first.summaries, evaluations: first.evaluations,
      evaluators: new Map([["task_completion", stallAfterOne]]) });
    await addSummary(first.summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    await addSummary(first.summaries, "run-2", "agent-a", "2026-08-28T02:00:00.000Z");
    await addSummary(first.summaries, "run-3", "agent-a", "2026-08-28T03:00:00.000Z");
    const job = await worker.enqueue({ evaluatorId: "task_completion" });
    await until(async () => (await first.jobStore.get(job.id))!, (item) => item.status === "running" && item.completedRuns === 1);

    // Restart: a fresh store stack over the same file, exactly like index.ts boot.
    const json = new JsonStore(first.file);
    await json.initialize();
    const summaries = new JsonRunSummaryStore(json);
    const evaluations = new JsonEvaluationStore(json, summaries);
    await evaluations.initialize();
    const jobStore = new JsonEvaluationJobStore(json);
    const calls: string[] = [];
    const resumed = new EvaluationJobWorker({ jobs: jobStore, summaries, evaluations, evaluators: new Map([["task_completion", passing(calls)]]) });
    await resumed.initialize();
    expect((await jobStore.get(job.id))!).toMatchObject({ status: "interrupted", lastError: "Interrupted by server restart" });

    await resumed.resume(job.id);
    const finished = await untilStatus(jobStore, job.id, "completed");
    expect(finished).toMatchObject({ totalRuns: 3, completedRuns: 3, failedRuns: 0, lastError: undefined });
    // The Run evaluated before the restart kept its stored result and was not evaluated again.
    expect(calls.sort()).toEqual(["run-1", "run-2"]);
    await expect(resumed.resume(job.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("drops evidence ids that are not bounded event-id shaped", async () => {
    const evaluator: RunEvaluator = {
      async evaluate() {
        return { passed: true, explanation: "ok", evidenceEventIds: ["evt_real-1", "leaked text with " + SECRET, "x".repeat(200)] };
      },
    };
    const { file, summaries, evaluations, jobStore, worker } = await setup(new Map([["task_completion", evaluator]]));
    await addSummary(summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    const job = await worker.enqueue({ evaluatorId: "task_completion" });
    await untilStatus(jobStore, job.id, "completed");
    expect((await evaluations.resultsForRun("run-1"))[0]?.evidenceEventIds).toEqual(["evt_real-1"]);
    expect(await readFile(file, "utf8")).not.toContain(SECRET);
  });

  it("backs off instead of hot-spinning when the job store cannot be written", async () => {
    const base = await setup();
    const inner = base.jobStore;
    let failWrites = false;
    const flaky: EvaluationJobStore = {
      create: async (job) => { const created = await inner.create(job); failWrites = true; return created; },
      get: (id) => inner.get(id),
      list: () => inner.list(),
      update: (id, mutation) => (failWrites ? Promise.reject(new Error("ENOSPC: disk full")) : inner.update(id, mutation)),
      markInterrupted: (reason) => inner.markInterrupted(reason),
    };
    const sleeps: number[] = [];
    const worker = new EvaluationJobWorker({
      jobs: flaky, summaries: base.summaries, evaluations: base.evaluations,
      evaluators: builtinRunEvaluators() as Map<string, RunEvaluator>,
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 3) failWrites = false; },
    });
    const job = await worker.enqueue({ evaluatorId: "terminal_status" });
    const finished = await untilStatus(inner, job.id, "completed");
    expect(finished.status).toBe("completed");
    // Three failed drain iterations, each separated by growing backoff — never a tight loop.
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it("refuses jobs for unknown evaluators and for evaluators without a runtime implementation", async () => {
    const { jobStore, worker } = await setup(builtinRunEvaluators() as Map<string, RunEvaluator>);
    await expect(worker.enqueue({ evaluatorId: "no-such-evaluator" })).rejects.toMatchObject({ statusCode: 404 });
    // task_completion is seeded, but its judge runtime arrives with #171 — refusing beats fabricating.
    await expect(worker.enqueue({ evaluatorId: "task_completion" })).rejects.toMatchObject({ statusCode: 501 });
    const job = await worker.enqueue({ evaluatorId: "terminal_status" });
    expect(job).toMatchObject({ evaluatorId: "terminal_status", evaluatorVersion: 1, status: "queued" });
    // The empty selection settles quickly; wait so the store is quiescent before afterEach removes the dir.
    await untilStatus(jobStore, job.id, "completed");
  });

  it("routes a user-defined llm_judge definition through the shared judge runtime (#192)", async () => {
    const seen: string[] = [];
    const judge: RunEvaluator = {
      async evaluate(_summary, definition) {
        seen.push(`${definition.id}@${definition.version}`);
        return { score: definition.maxScore, passed: true, explanation: "judged " + definition.rubric, evidenceEventIds: [] };
      },
    };
    const { summaries, evaluations, jobStore, worker } = await setup(new Map([["task_completion", judge]]));
    await addSummary(summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    const custom = await evaluations.createDefinition({
      id: "politeness_judge", name: "Politeness", type: "llm_judge", rubric: "Score politeness.",
      minScore: 0, maxScore: 10, passThreshold: 7, config: {}, setsTaskOutcome: false,
    });

    const job = await worker.enqueue({ evaluatorId: custom.id });
    await untilStatus(jobStore, job.id, "completed");
    expect(seen).toEqual(["politeness_judge@1"]);
    // AC (#192): the result names the user-defined evaluator's own id and version.
    expect((await evaluations.resultsForRun("run-1"))[0]).toMatchObject({ evaluatorId: "politeness_judge", evaluatorVersion: 1, score: 10, passed: true });

    // Deterministic definitions never fall through to the judge runtime.
    await expect(worker.enqueue({ evaluatorId: "expected_tool" })).rejects.toMatchObject({ statusCode: 501 });
  });

  it("terminal_status judges deterministically from the stored summary", async () => {
    const { summaries, evaluations, jobStore, worker } = await setup(builtinRunEvaluators() as Map<string, RunEvaluator>);
    await addSummary(summaries, "run-ok", "agent-a", "2026-08-28T01:00:00.000Z", "completed");
    await addSummary(summaries, "run-bad", "agent-a", "2026-08-28T02:00:00.000Z", "timeout");
    const definition = (await evaluations.getDefinition("terminal_status", 1))!;

    expect(await terminalStatusEvaluator.evaluate((await summaries.get("run-ok"))!, definition))
      .toMatchObject({ passed: true, score: definition.maxScore, metadata: { observed: "completed", expected: "completed" } });
    const job = await worker.enqueue({ evaluatorId: "terminal_status" });
    await untilStatus(jobStore, job.id, "completed");
    expect((await evaluations.resultsForRun("run-bad"))[0]).toMatchObject({ passed: false, score: 0 });
    // A deterministic result never carries a judge model, and never flips taskOutcome.
    expect((await evaluations.resultsForRun("run-ok"))[0]?.evaluatorModel).toBeUndefined();
    expect(await summaries.get("run-ok")).toMatchObject({ taskOutcome: "unknown" });
  });
});

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "Completed: " + request.prompt, threadId: request.threadId ?? "fake-thread", usage: { inputTokens: 12, outputTokens: 5 } };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("EvaluationJobWorker and live Runs", () => {
  it("never makes an Agent Run wait on a running evaluation job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evaluation-jobs-live-"));
    dirs.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const json = new JsonStore(path.join(root, "data", "db.json"));
    await json.initialize();
    const service = new AgentService(config, json, new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory), new FakeRunner());
    await service.initialize();
    const summaries = new JsonRunSummaryStore(json);
    const evaluations = new JsonEvaluationStore(json, summaries);
    await evaluations.initialize();
    const jobStore = new JsonEvaluationJobStore(json);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const evaluator: RunEvaluator = {
      async evaluate() {
        await gate;
        return { passed: true, explanation: "ok", evidenceEventIds: [] };
      },
    };
    const worker = new EvaluationJobWorker({ jobs: jobStore, summaries, evaluations, evaluators: new Map([["task_completion", evaluator]]) });
    await addSummary(summaries, "run-old-1", "agent-history", "2026-08-28T01:00:00.000Z");
    await addSummary(summaries, "run-old-2", "agent-history", "2026-08-28T02:00:00.000Z");
    const job = await worker.enqueue({ evaluatorId: "task_completion" });
    await untilStatus(jobStore, job.id, "running");

    // The job is blocked inside a model call; a fresh Run must still complete in normal time.
    const agent = await service.createAgent({ name: "Live" });
    const startedAt = Date.now();
    const { run } = await service.sendMessage(agent.id, "hello");
    const settled = await until(async () => service.getRun(run.id), (r) => r.status !== "queued" && r.status !== "running", 2_000);
    expect(settled.status).toBe("completed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    release();
    const finished = await untilStatus(jobStore, job.id, "completed");
    expect(finished).toMatchObject({ totalRuns: 2, completedRuns: 2 });
  });
});
