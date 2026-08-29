import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EvaluatorDefinition } from "./evaluation.js";
import { observationEventSchema, type CapturePolicy, type ObservationEvent } from "./schema.js";
import { summaryFromView } from "./summary.js";
import { buildTrace } from "./query.js";
import { RecoveryQualityEvaluator, isRecoverableFailure } from "./recovery-quality.js";
import { FakeTaskCompletionJudge, type TaskCompletionSource } from "./task-completion.js";

const fixtureSchema = z.object({
  cases: z.array(z.object({
    name: z.string(),
    capturePolicy: z.enum(["metadata_only", "safe_summary"]),
    userRequest: z.string(),
    finalResponse: z.string(),
    events: z.array(observationEventSchema),
  })),
});

async function fixtures(file: "recovery-quality.json" | "task-completion.json") {
  const raw = await readFile(new URL(`../../../../fixtures/evaluation/${file}`, import.meta.url), "utf8");
  return fixtureSchema.parse(JSON.parse(raw)).cases;
}

const recovered = async () => (await fixtures("recovery-quality.json"))[0]!;
const gaveUp = async () => (await fixtures("task-completion.json"))[0]!;
const clean = async () => (await fixtures("task-completion.json"))[1]!;

const definition: EvaluatorDefinition = {
  id: "recovery_quality",
  name: "Recovery Quality",
  version: 1,
  type: "llm_judge",
  rubric: "Score recovery after each failure from cited evidence.",
  model: "deepseek-v4-pro-260425",
  minScore: 1,
  maxScore: 5,
  passThreshold: 4,
  config: {},
  setsTaskOutcome: false,
  createdAt: "2026-08-29T00:00:00.000Z",
};

const source = (input: { runId: string; userRequest: string; finalResponse?: string; events: ObservationEvent[] }): TaskCompletionSource => ({
  async load(runId) {
    expect(runId).toBe(input.runId);
    return { userRequest: input.userRequest, finalResponse: input.finalResponse, events: input.events };
  },
});

const summarize = (events: ObservationEvent[], capturePolicy: CapturePolicy) => summaryFromView(buildTrace(events, { capturePolicy }));

describe("isRecoverableFailure", () => {
  it("selects denials, errors and timeouts but never a user cancel or an ok event", async () => {
    const s1 = await recovered();
    expect(s1.events.filter(isRecoverableFailure).map((event) => event.eventId)).toEqual(["evt_s1_fail1", "evt_s1_fail2"]);
    const cancelled = { ...s1.events[1]!, status: "cancelled" as const };
    expect(isRecoverableFailure(cancelled)).toBe(false);
    const denied = { ...s1.events[3]!, type: "policy.denied", status: "unset" as const };
    expect(isRecoverableFailure(observationEventSchema.parse(denied))).toBe(true);
  });

  it("never treats an observation-plane self-report as a failure the Agent could recover from", async () => {
    const s1 = await recovered();
    const degraded = { ...s1.events[1]!, type: "telemetry.degraded", name: "telemetry.degraded", status: "error" as const };
    expect(isRecoverableFailure(observationEventSchema.parse(degraded))).toBe(false);
    const truncated = { ...s1.events[1]!, type: "trace.truncated", name: "trace.truncated", status: "error" as const };
    expect(isRecoverableFailure(observationEventSchema.parse(truncated))).toBe(false);
  });
});

describe("RecoveryQualityEvaluator", () => {
  it("stores a notEligible verdict without calling the judge when the trace shows no failure", async () => {
    const item = await clean();
    const summary = summarize(item.events, item.capturePolicy);
    let calls = 0;
    const judge = new FakeTaskCompletionJudge(async () => { calls++; return { score: 5, passed: true, explanation: "wrong", citedEventIds: [] }; });
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: item.events }), judge)
      .evaluate(summary, definition);
    expect(calls).toBe(0);
    expect(result.score).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.metadata).toEqual({ notEligible: true, observedEvents: item.events.length });
    expect(result.explanation).toContain("Not eligible");
  });

  it("scores UAT3 S1 (two failures, recovered) high with the failure and recovery events cited", async () => {
    const item = await recovered();
    const summary = summarize(item.events, item.capturePolicy);
    const judge = new FakeTaskCompletionJudge(async (request) => {
      const view = JSON.parse(request.view) as { failuresAndDenials: { eventIds: string[] }; recovery: { items: Array<{ failedEventId: string; recoveredEventId: string }> } };
      // The shared view already pairs each failure with its recovery — cite one pair like the real judge would.
      expect(view.failuresAndDenials.eventIds).toEqual(["evt_s1_fail1", "evt_s1_fail2"]);
      expect(view.recovery.items).toHaveLength(2);
      const pair = view.recovery.items[0]!;
      return { score: 5, passed: true, explanation: "Both npm test failures were addressed by a workspace fix and a passing retry.", citedEventIds: [pair.failedEventId, pair.recoveredEventId] };
    });
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: item.events }), judge)
      .evaluate(summary, definition);
    expect(result).toMatchObject({ score: 5, passed: true, evidenceEventIds: ["evt_s1_fail1", "evt_s1_retry"], evaluatorModel: "fake-task-completion" });
    expect(result.metadata).toEqual({ failuresObserved: 2 });
  });

  it("scores UAT3 S2 (curl missing, gave up) low and cites the failure event", async () => {
    const item = await gaveUp();
    const summary = summarize(item.events, item.capturePolicy);
    const judge = new FakeTaskCompletionJudge(async () => ({
      score: 2, passed: false,
      explanation: "The curl failure was never addressed: no alternative was attempted before giving up.",
      citedEventIds: ["evt_uat3_curl"],
    }));
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: item.events }), judge)
      .evaluate(summary, definition);
    expect(result).toMatchObject({ score: 2, passed: false, evidenceEventIds: ["evt_uat3_curl"] });
    expect(result.metadata).toEqual({ failuresObserved: 1 });
  });

  it("judges silent abandonment over an empty final response instead of skipping it", async () => {
    const item = await gaveUp();
    const summary = summarize(item.events, item.capturePolicy);
    let seenFinalResponse: string | undefined;
    const judge = new FakeTaskCompletionJudge(async (request) => {
      seenFinalResponse = (JSON.parse(request.view) as { conversation: { finalResponse: { text: string } } }).conversation.finalResponse.text;
      return { score: 1, passed: false, explanation: "The Run abandoned the failure silently.", citedEventIds: ["evt_uat3_curl"] };
    });
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, events: item.events }), judge)
      .evaluate(summary, definition);
    expect(seenFinalResponse).toBe("");
    expect(result).toMatchObject({ score: 1, passed: false });
    expect(result.metadata).toMatchObject({ noFinalResponse: true });
  });

  it("fails the Run with provenance when stored evidence was evicted, never a clean verdict", async () => {
    const item = await gaveUp();
    const summary = summarize(item.events, item.capturePolicy);
    const judge = new FakeTaskCompletionJudge(async () => ({ score: 5, passed: true, explanation: "wrong", citedEventIds: [] }));
    await expect(new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: [] }), judge)
      .evaluate(summary, definition)).rejects.toThrow("no stored events");
  });

  it("refuses a notEligible verdict the rollup contradicts: summary counts failures the events no longer show", async () => {
    const item = await gaveUp();
    const summary = summarize(item.events, item.capturePolicy); // counts the curl tool failure
    const withoutFailure = item.events.filter((event) => event.eventId !== "evt_uat3_curl");
    const judge = new FakeTaskCompletionJudge(async () => ({ score: 5, passed: true, explanation: "wrong", citedEventIds: [] }));
    await expect(new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: withoutFailure }), judge)
      .evaluate(summary, definition)).rejects.toThrow("counts failures");
  });

  it("flags evidenceIncomplete when the stored events read back fewer than the rollup counted", async () => {
    const item = await recovered();
    const summary = summarize(item.events, item.capturePolicy);
    const partial = item.events.filter((event) => event.eventId !== "evt_s1_fix"); // a non-failure event was evicted
    const judge = new FakeTaskCompletionJudge(async () => ({ score: 5, passed: true, explanation: "recovered", citedEventIds: ["evt_s1_fail1", "evt_s1_retry"] }));
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: partial }), judge)
      .evaluate(summary, definition);
    expect(result.metadata).toMatchObject({ failuresObserved: 2, evidenceIncomplete: true });
  });

  it("rejects out-of-range or threshold-inconsistent judge verdicts", async () => {
    const item = await gaveUp();
    const summary = summarize(item.events, item.capturePolicy);
    const input = () => source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: item.events });
    const outOfRange = new FakeTaskCompletionJudge(async () => ({ score: 7, passed: true, explanation: "bad", citedEventIds: [] }));
    await expect(new RecoveryQualityEvaluator(input(), outOfRange).evaluate(summary, definition)).rejects.toThrow();
    const inconsistent = new FakeTaskCompletionJudge(async () => ({ score: 2, passed: true, explanation: "bad", citedEventIds: [] }));
    await expect(new RecoveryQualityEvaluator(input(), inconsistent).evaluate(summary, definition)).rejects.toThrow("inconsistent");
  });

  it("drops unknown citations, flags a verdict that cites no failure event, and redacts the explanation", async () => {
    const item = await recovered();
    const summary = summarize(item.events, item.capturePolicy);
    const secret = "sk-proj-" + "C".repeat(24);
    const judge = new FakeTaskCompletionJudge(async () => ({
      score: 4, passed: true, explanation: "recovered " + secret, citedEventIds: ["evt_s1_retry", "evt_missing"],
    }));
    const result = await new RecoveryQualityEvaluator(source({ runId: summary.runId, userRequest: item.userRequest, finalResponse: item.finalResponse, events: item.events }), judge)
      .evaluate(summary, definition);
    expect(result.evidenceEventIds).toEqual(["evt_s1_retry"]);
    expect(result.metadata).toMatchObject({ uncited: true, failureUncited: true });
    expect(result.explanation).not.toContain(secret);
  });
});
