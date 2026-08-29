import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EvaluatorDefinition } from "./evaluation.js";
import { JsonEvaluationStore } from "./evaluation.js";
import { observationEventSchema, type CapturePolicy, type ObservationEvent } from "./schema.js";
import { summaryFromView } from "./summary.js";
import { JsonRunSummaryStore } from "./summary.js";
import { buildTrace } from "./query.js";
import { JsonStore } from "../store.js";
import {
  ArkTaskCompletionJudge,
  FakeTaskCompletionJudge,
  TaskCompletionEvaluator,
  buildEvaluationView,
  taskCompletionOutputSchema,
  type TaskCompletionSource,
} from "./task-completion.js";

const fixtureSchema = z.object({
  cases: z.array(z.object({
    name: z.string(),
    capturePolicy: z.enum(["metadata_only", "safe_summary"]),
    userRequest: z.string(),
    finalResponse: z.string(),
    events: z.array(observationEventSchema),
  })),
});

async function fixtures() {
  const raw = await readFile(new URL("../../../../fixtures/evaluation/task-completion.json", import.meta.url), "utf8");
  return fixtureSchema.parse(JSON.parse(raw)).cases;
}

const definition: EvaluatorDefinition = {
  id: "task_completion",
  name: "Task Completion",
  version: 1,
  type: "llm_judge",
  rubric: "Judge completion from cited evidence.",
  model: "deepseek-v4-pro-260425",
  minScore: 1,
  maxScore: 5,
  passThreshold: 4,
  config: {},
  setsTaskOutcome: true,
  createdAt: "2026-08-28T00:00:00.000Z",
};

const source = (input: { runId: string; capturePolicy: CapturePolicy; userRequest: string; finalResponse?: string; events: ObservationEvent[] }): TaskCompletionSource => ({
  async load(runId) {
    expect(runId).toBe(input.runId);
    return { userRequest: input.userRequest, finalResponse: input.finalResponse, events: input.events };
  },
});

describe("buildEvaluationView", () => {
  it("builds bounded, redacted, evidence-linked views for the two UAT fixtures", async () => {
    const cases = await fixtures();
    for (const item of cases) {
      const summary = summaryFromView(buildTrace(item.events, { capturePolicy: item.capturePolicy }));
      const secret = "sk-proj-" + "A".repeat(24);
      const built = buildEvaluationView({ summary, userRequest: item.userRequest + " " + secret, finalResponse: item.finalResponse, events: item.events });
      expect(built.text.length).toBeLessThanOrEqual(16_384);
      expect(built.text).not.toContain(secret);
      expect(built.text).toContain("[REDACTED:openai_key]");
      expect(new Set(built.eventIds)).toEqual(new Set(item.events.map((event) => event.eventId)));
      const view = JSON.parse(built.text);
      expect(view.conversation.request.eventIds).toContain(item.events[0]!.eventId);
      expect(view.conversation.finalResponse.eventIds).toContain(item.events.at(-1)!.eventId);
    }
  });

  it("keeps command heads only for safe_summary", async () => {
    const failed = (await fixtures())[0]!;
    const summary = summaryFromView(buildTrace(failed.events, { capturePolicy: "safe_summary" }));
    const safe = JSON.parse(buildEvaluationView({ summary, userRequest: failed.userRequest, finalResponse: failed.finalResponse, events: failed.events }).text);
    const metadata = JSON.parse(buildEvaluationView({ summary: { ...summary, capturePolicy: "metadata_only" }, userRequest: failed.userRequest, finalResponse: failed.finalResponse, events: failed.events }).text);
    expect(safe.tools.items[0].commandHead).toBe("curl https://example.invalid/status");
    expect(metadata.tools.items[0].commandHead).toBeUndefined();
  });
});

describe("TaskCompletionEvaluator", () => {
  it("fails the completed UAT3 Run and cites the exit-127 event", async () => {
    const failed = (await fixtures())[0]!;
    const summary = summaryFromView(buildTrace(failed.events, { capturePolicy: failed.capturePolicy }));
    const judge = new FakeTaskCompletionJudge();
    const result = await new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: failed.capturePolicy, userRequest: failed.userRequest, finalResponse: failed.finalResponse, events: failed.events }), judge)
      .evaluate(summary, definition);
    expect(result).toMatchObject({ score: 2, passed: false, evidenceEventIds: ["evt_uat3_curl"], evaluatorModel: "fake-task-completion" });
    expect(result.explanation).toContain("exit code 127");
  });

  it("passes UAT4 and cites both workspace change and the passing post-check", async () => {
    const success = (await fixtures())[1]!;
    const summary = summaryFromView(buildTrace(success.events, { capturePolicy: success.capturePolicy }));
    const result = await new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: success.capturePolicy, userRequest: success.userRequest, finalResponse: success.finalResponse, events: success.events }), new FakeTaskCompletionJudge())
      .evaluate(summary, definition);
    expect(result).toMatchObject({ score: 5, passed: true, evidenceEventIds: ["evt_uat4_workspace", "evt_uat4_check"] });
  });

  it("rejects malformed or threshold-inconsistent judge output", async () => {
    const success = (await fixtures())[1]!;
    const summary = summaryFromView(buildTrace(success.events, { capturePolicy: success.capturePolicy }));
    const invalid = new FakeTaskCompletionJudge(async () => ({ score: 7, passed: true, explanation: "bad", citedEventIds: [] }));
    await expect(new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: success.capturePolicy, userRequest: success.userRequest, finalResponse: success.finalResponse, events: success.events }), invalid).evaluate(summary, definition)).rejects.toThrow();
    const inconsistent = new FakeTaskCompletionJudge(async () => ({ score: 2, passed: true, explanation: "bad", citedEventIds: [] }));
    await expect(new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: success.capturePolicy, userRequest: success.userRequest, finalResponse: success.finalResponse, events: success.events }), inconsistent).evaluate(summary, definition)).rejects.toThrow("inconsistent");
  });

  it("does not call a judge when the conversation has no final response", async () => {
    const failed = (await fixtures())[0]!;
    const summary = summaryFromView(buildTrace(failed.events, { capturePolicy: failed.capturePolicy }));
    let calls = 0;
    const judge = new FakeTaskCompletionJudge(async () => { calls++; return { score: 5, passed: true, explanation: "wrong", citedEventIds: [] }; });
    const result = await new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: failed.capturePolicy, userRequest: failed.userRequest, events: failed.events }), judge).evaluate(summary, definition);
    expect(result).toEqual({ passed: false, explanation: "no final response", evidenceEventIds: [], metadata: { noFinalResponse: true } });
    expect(calls).toBe(0);
  });

  it("drops missing citations, marks metadata.uncited, and redacts the explanation", async () => {
    const success = (await fixtures())[1]!;
    const summary = summaryFromView(buildTrace(success.events, { capturePolicy: success.capturePolicy }));
    const secret = "sk-proj-" + "B".repeat(24);
    const judge = new FakeTaskCompletionJudge(async () => ({ score: 5, passed: true, explanation: "done " + secret, citedEventIds: ["evt_uat4_workspace", "evt_missing"] }));
    const result = await new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: success.capturePolicy, userRequest: success.userRequest, finalResponse: success.finalResponse, events: success.events }), judge).evaluate(summary, definition);
    expect(result.evidenceEventIds).toEqual(["evt_uat4_workspace"]);
    expect(result.metadata).toMatchObject({ uncited: true });
    expect(result.explanation).not.toContain(secret);
  });

  it("persists only the verdict and citations, never the evaluation request or response text", async () => {
    const success = (await fixtures())[1]!;
    const summary = summaryFromView(buildTrace(success.events, { capturePolicy: success.capturePolicy }));
    const root = await mkdtemp(path.join(tmpdir(), "task-completion-persist-"));
    try {
      const json = new JsonStore(path.join(root, "launchpad.json"));
      await json.initialize();
      const summaries = new JsonRunSummaryStore(json);
      await summaries.upsert(summary);
      const evaluations = new JsonEvaluationStore(json, summaries, undefined, definition.model);
      await evaluations.initialize();
      const evaluated = await new TaskCompletionEvaluator(source({ runId: summary.runId, capturePolicy: success.capturePolicy, userRequest: success.userRequest, finalResponse: success.finalResponse, events: success.events }), new FakeTaskCompletionJudge()).evaluate(summary, definition);
      await evaluations.putResult({
        runId: summary.runId,
        evaluatorId: definition.id,
        evaluatorVersion: definition.version,
        score: evaluated.score,
        passed: evaluated.passed,
        explanation: evaluated.explanation,
        evidenceEventIds: evaluated.evidenceEventIds,
        evaluatorModel: evaluated.evaluatorModel,
        metadata: evaluated.metadata ?? {},
        evaluatedAt: "2026-08-28T01:00:00.000Z",
      });
      const persistedResult = JSON.stringify(json.snapshot().evaluationResults[0]);
      expect(persistedResult).not.toContain(success.userRequest);
      expect(persistedResult).not.toContain(success.finalResponse);
      expect(JSON.stringify(success.events)).not.toContain(success.userRequest);
      expect(JSON.stringify(success.events)).not.toContain(success.finalResponse);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ArkTaskCompletionJudge", () => {
  it("uses the Responses API at temperature zero and parses strict JSON output", async () => {
    let request: RequestInit | undefined;
    const judge = new ArkTaskCompletionJudge({
      apiKey: "test-key",
      baseUrl: "https://ark.example/api/v3",
      model: "deepseek-v4-pro-260425",
      fetch: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"score":4,"passed":true,"explanation":"done","citedEventIds":["evt_1"]}' }] }] }), { status: 200 });
      },
    });
    const output = taskCompletionOutputSchema.parse(await judge.judge({ definition, view: "{}" }));
    expect(output).toEqual({ score: 4, passed: true, explanation: "done", citedEventIds: ["evt_1"] });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ model: "deepseek-v4-pro-260425", temperature: 0 });
    expect(JSON.stringify(request?.headers)).not.toContain("test-key");
  });

  it("reports quota failures without including provider response bodies", async () => {
    const judge = new ArkTaskCompletionJudge({ apiKey: "test-key", baseUrl: "https://ark.example/api/v3", model: "m", fetch: async () => new Response("sensitive provider body", { status: 429, statusText: "Too Many Requests", headers: { "x-request-id": "req-429" } }) });
    await expect(judge.judge({ definition, view: "{}" })).rejects.toThrow("429 Too Many Requests (request id: req-429)");
    await expect(judge.judge({ definition, view: "{}" })).rejects.not.toThrow("sensitive provider body");
  });
});
