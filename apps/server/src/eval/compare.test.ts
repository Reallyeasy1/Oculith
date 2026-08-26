import { describe, expect, it } from "vitest";
import { compareEvalRuns } from "./compare.js";
import type { EvalRun } from "../types.js";

const run = (pass: boolean, caseIds = ["case"]): EvalRun => ({ id: pass ? "base" : "candidate", caseIds, target: { agentId: "a", configHash: "h", snapshot: {} as EvalRun["target"]["snapshot"] }, runIds: [pass ? "r1" : "r2"], results: [{ caseId: "case", runId: pass ? "r1" : "r2", results: [{ type: "max_duration_ms", pass, expected: 10, observed: pass ? 5 : 15, evidenceEventIds: [], message: "x" }] }], status: "completed", createdAt: "" });
describe("EvalRun comparison", () => {
  it("flags only pass-to-fail and returns evidence links/deltas", () => {
    const result = compareEvalRuns(run(true), run(false));
    expect(result).toMatchObject({ regressions: 1, cases: [{ regression: true, traceLinks: { baseline: "r1", candidate: "r2" }, assertions: [expect.objectContaining({ regression: true, delta: 10 })] }] });
  });
  it("refuses mismatched case sets", () => { expect(() => compareEvalRuns(run(true), run(true, ["other"]))).toThrow("same case set"); });
});
