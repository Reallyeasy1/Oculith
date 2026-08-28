import { describe, expect, it } from "vitest";
import { compareEvalRuns } from "./compare.js";
import type { EvalRun } from "../types.js";
import type { EvalResult } from "./evaluators.js";

const assertion = (pass: boolean, observed: number): EvalResult => ({ type: "max_duration_ms", pass, expected: 10, observed, evidenceEventIds: [], message: "x" });
const run = (id: string, passes: (boolean | undefined)[][], caseIds = passes.map((_, index) => `case-${index}`)): EvalRun => ({
  id, caseIds, target: { agentId: "a", configHash: "h", snapshot: {} as EvalRun["target"]["snapshot"] }, runIds: [`${id}-run`],
  results: passes.flatMap((flags, index) => flags[0] === undefined ? [] : [{ caseId: `case-${index}`, runId: `${id}-run-${index}`, results: flags.map((pass) => assertion(pass!, pass ? 5 : 15)) }]),
  status: "completed", createdAt: "",
});

describe("EvalRun comparison", () => {
  it.each([
    { name: "PASS→FAIL is a regression", before: [true], after: [false], regression: true, regressions: 1 },
    { name: "FAIL→PASS is shown but not a regression", before: [false], after: [true], regression: false, regressions: 0 },
    { name: "PASS→PASS unchanged", before: [true], after: [true], regression: false, regressions: 0 },
    { name: "FAIL→FAIL unchanged", before: [false], after: [false], regression: false, regressions: 0 },
    { name: "missing candidate result flags a regression", before: [true], after: [undefined], regression: true, regressions: 1 },
    { name: "two assertions in one case both PASS→FAIL count as 2", before: [true, true], after: [false, false], regression: true, regressions: 2 },
  ])("$name", ({ before, after, regression, regressions }) => {
    const result = compareEvalRuns(run("base", [before]), run("candidate", [after]));
    expect(result.regressions).toBe(regressions);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ caseId: "case-0", regression });
    expect(result.cases[0]?.assertions).toHaveLength(before.length);
  });

  it("returns evidence links, deltas and a message on missing candidate rows", () => {
    const result = compareEvalRuns(run("base", [[true]]), run("candidate", [[false]]));
    expect(result.cases[0]).toMatchObject({ traceLinks: { baseline: "base-run-0", candidate: "candidate-run-0" }, assertions: [expect.objectContaining({ regression: true, delta: 10 })] });
    const missing = compareEvalRuns(run("base", [[true]]), { ...run("candidate", [[undefined]]), results: [{ caseId: "case-0", results: [], error: "boom" }] });
    expect(missing.cases[0]?.assertions[0]).toMatchObject({ regression: true, candidate: undefined, message: "boom" });
    expect(compareEvalRuns(run("base", [[true]]), run("candidate", [[undefined]])).cases[0]?.assertions[0]?.message).toBe("candidate result missing");
  });

  it("flags baseline/candidate pairs whose template hashes differ without throwing", () => {
    const base = { ...run("base", [[true]]), templateHashes: { fixture: "aaa" } };
    expect(compareEvalRuns(base, { ...run("candidate", [[true]]), templateHashes: { fixture: "bbb" } }).templateMismatch).toBe(true);
    expect(compareEvalRuns(base, { ...run("candidate", [[true]]), templateHashes: { fixture: "aaa" } }).templateMismatch).toBe(false);
    expect(compareEvalRuns(base, run("candidate", [[true]])).templateMismatch).toBe(false); // pre-#176 EvalRun: unknown, never flagged
  });

  it("refuses mismatched case sets", () => { expect(() => compareEvalRuns(run("base", [[true]]), run("candidate", [[true]], ["other"]))).toThrow("same case set"); });
});
