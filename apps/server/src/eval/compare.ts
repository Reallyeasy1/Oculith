import { HttpError } from "../errors.js";
import type { EvalRun } from "../types.js";

export interface ComparisonAssertion {
  type: string;
  baseline: EvalRun["results"][number]["results"][number] | undefined;
  candidate: EvalRun["results"][number]["results"][number] | undefined;
  delta?: number | undefined;
  regression: boolean;
  message?: string | undefined;
}
export interface EvalComparison {
  cases: { caseId: string; assertions: ComparisonAssertion[]; regression: boolean; traceLinks: { baseline?: string; candidate?: string } }[];
  regressions: number;
}

export function compareEvalRuns(baseline: EvalRun, candidate: EvalRun): EvalComparison {
  const left = [...baseline.caseIds].sort(), right = [...candidate.caseIds].sort();
  if (left.join("\u0000") !== right.join("\u0000")) throw new HttpError(400, "Eval Runs must use the same case set");
  let regressions = 0;
  const cases = baseline.caseIds.map((caseId) => {
    const base = baseline.results.find((item) => item.caseId === caseId);
    const next = candidate.results.find((item) => item.caseId === caseId);
    const count = Math.max(base?.results.length ?? 0, next?.results.length ?? 0);
    const assertions = Array.from({ length: count }, (_, index) => {
      const before = base?.results[index], after = next?.results[index];
      const regression = before?.pass === true && after?.pass !== true;
      const delta = typeof before?.observed === "number" && typeof after?.observed === "number" ? after.observed - before.observed : undefined;
      const message = after === undefined ? next?.error ?? "candidate result missing" : undefined;
      return { type: after?.type ?? before?.type ?? "missing", baseline: before, candidate: after, ...(delta !== undefined ? { delta } : {}), regression, ...(message !== undefined ? { message } : {}) };
    });
    const regression = assertions.some((item) => item.regression);
    regressions += assertions.filter((item) => item.regression).length;
    return { caseId, assertions, regression, traceLinks: { ...(base?.runId ? { baseline: base.runId } : {}), ...(next?.runId ? { candidate: next.runId } : {}) } };
  });
  return { cases, regressions };
}
