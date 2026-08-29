import { describe, expect, it } from "vitest";
import { emptyEvaluatorForm, evaluatorFormError, evaluatorPayload } from "./evaluator-form";

const valid = { ...emptyEvaluatorForm, name: "Politeness Judge", rubric: "Score the reply for politeness." };

describe("evaluatorFormError", () => {
  it("accepts the default score range with a name and rubric", () => {
    expect(evaluatorFormError(valid)).toBeNull();
  });

  it("mirrors the server's boundary rules with actionable messages", () => {
    expect(evaluatorFormError({ ...valid, name: "  " })).toMatch(/name/i);
    expect(evaluatorFormError({ ...valid, name: "***" })).toMatch(/letter or digit/i);
    expect(evaluatorFormError({ ...valid, rubric: "" })).toMatch(/rubric/i);
    expect(evaluatorFormError({ ...valid, rubric: "x".repeat(4_001) })).toMatch(/4000/);
    expect(evaluatorFormError({ ...valid, minScore: "one" })).toMatch(/whole number/i);
    expect(evaluatorFormError({ ...valid, minScore: "2.5" })).toMatch(/whole number/i);
    expect(evaluatorFormError({ ...valid, minScore: "5", maxScore: "5" })).toMatch(/less than/i);
    expect(evaluatorFormError({ ...valid, passThreshold: "9" })).toMatch(/between/i);
    expect(evaluatorFormError({ ...valid, passThreshold: "0" })).toMatch(/between/i);
  });
});

describe("evaluatorPayload", () => {
  it("shapes the POST /api/evaluators body, omitting setsTaskOutcome unless opted in", () => {
    expect(evaluatorPayload({ ...valid, name: " Politeness Judge ", rubric: " Be fair. " })).toEqual({
      name: "Politeness Judge", rubric: "Be fair.", minScore: 1, maxScore: 5, passThreshold: 4,
    });
    expect(evaluatorPayload({ ...valid, setsTaskOutcome: true })).toMatchObject({ setsTaskOutcome: true });
  });
});
