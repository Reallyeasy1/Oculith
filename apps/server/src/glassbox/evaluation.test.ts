import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { JsonEvaluationStore, SEEDED_EVALUATORS, type EvaluatorDefinitionInput } from "./evaluation.js";
import { buildTrace } from "./query.js";
import { JsonRunSummaryStore, summaryFromView } from "./summary.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(redact?: (text: string) => string) {
  const dir = await mkdtemp(path.join(tmpdir(), "evaluation-store-"));
  dirs.push(dir);
  const file = path.join(dir, "launchpad.json");
  const json = new JsonStore(file);
  await json.initialize();
  const summaries = new JsonRunSummaryStore(json);
  const store = new JsonEvaluationStore(json, summaries, redact);
  await store.initialize();
  return { file, json, summaries, store };
}

const custom = (rubric: string): EvaluatorDefinitionInput => ({
  id: "custom-quality",
  name: "Custom quality",
  type: "llm_judge",
  rubric,
  model: "judge-model",
  minScore: 1,
  maxScore: 5,
  passThreshold: 4,
  setsTaskOutcome: false,
  config: { mode: "strict" },
});

async function addSummary(summaries: JsonRunSummaryStore, runId: string, agentId: string, startedAt: string) {
  const base = summaryFromView(buildTrace([], { capturePolicy: "metadata_only" }));
  await summaries.upsert({ ...base, runId, traceId: "trace-" + runId, agentId, startedAt, executionStatus: "completed", eventCount: 1 });
}

describe("JsonEvaluationStore", () => {
  it("seeds the shared evaluator catalogue once and survives a reload", async () => {
    const { file, store } = await setup();
    expect(await store.listDefinitions()).toHaveLength(SEEDED_EVALUATORS.length);
    expect(await store.getDefinition("task_completion", 1)).toMatchObject({ type: "llm_judge", passThreshold: 4, setsTaskOutcome: true });

    const reopenedJson = new JsonStore(file);
    await reopenedJson.initialize();
    const reopened = new JsonEvaluationStore(reopenedJson, new JsonRunSummaryStore(reopenedJson));
    await reopened.initialize();
    expect(await reopened.listDefinitions()).toHaveLength(SEEDED_EVALUATORS.length);
  });

  it("keeps definitions immutable and creates a new version only when versioned fields change", async () => {
    const { store } = await setup();
    const v1 = await store.createDefinition(custom("Score correctness."));
    const unchanged = await store.createDefinition(custom("Score correctness."));
    const v2 = await store.createDefinition(custom("Score correctness and clarity."));

    expect([v1.version, unchanged.version, v2.version]).toEqual([1, 1, 2]);
    v1.rubric = "caller mutation";
    expect((await store.getDefinition(v1.id, 1))?.rubric).toBe("Score correctness.");
    expect((await store.getDefinition(v1.id, 2))?.rubric).toBe("Score correctness and clarity.");
  });

  it("redacts before persistence, keeps result history, exposes only the latest value, and updates taskOutcome", async () => {
    const { file, json, summaries, store } = await setup();
    await addSummary(summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    await addSummary(summaries, "run-2", "agent-b", "2026-08-28T02:00:00.000Z");
    const secret = "sk-proj-" + "A".repeat(24);

    await store.putResult({ runId: "run-1", evaluatorId: "task_completion", evaluatorVersion: 1, score: 2, passed: false,
      explanation: "First verdict exposed " + secret, evidenceEventIds: ["evt-1"], evaluatorModel: "judge-model", metadata: { note: secret, apiKey: secret }, evaluatedAt: "2026-08-28T03:00:00.000Z", jobId: "job-1" });
    await store.putResult({ runId: "run-1", evaluatorId: "task_completion", evaluatorVersion: 1, score: 5, passed: true,
      explanation: "Second verdict is clean", evidenceEventIds: ["evt-2"], evaluatorModel: "judge-model", metadata: {}, evaluatedAt: "2026-08-28T04:00:00.000Z", jobId: "job-2" });

    const current = await store.resultsForRun("run-1");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ score: 5, passed: true, explanation: "Second verdict is clean", jobId: "job-2" });
    expect(json.snapshot().evaluationResults).toHaveLength(2);
    expect(await readFile(file, "utf8")).not.toContain(secret);
    expect(await summaries.get("run-1")).toMatchObject({ taskOutcome: "passed", taskOutcomeSource: "evaluator:task_completion@1" });
    expect(await store.query({ agentId: "agent-a", evaluatorId: "task_completion", version: 1, from: "2026-08-28T03:30:00.000Z" })).toEqual(current);
    expect(await store.query({ agentId: "agent-b" })).toEqual([]);
  });

  it("fails closed when explanation redaction fails", async () => {
    const { summaries, store } = await setup(() => { throw new Error("scanner failed"); });
    await addSummary(summaries, "run-1", "agent-a", "2026-08-28T01:00:00.000Z");
    const result = await store.putResult({ runId: "run-1", evaluatorId: "task_completion", evaluatorVersion: 1, passed: false,
      explanation: "must not survive", evidenceEventIds: [], metadata: {}, evaluatedAt: "2026-08-28T03:00:00.000Z" });
    expect(result.explanation).toBe("[REDACTED:failed_closed]");
  });
});
