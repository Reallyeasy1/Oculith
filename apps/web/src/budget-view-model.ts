import type { AgentBudgetReport } from "./types";

/** #255: banner text for an Agent whose pre-run gate is refusing new Runs; null hides the banner.
 * Honesty note baked into the copy: the gate is pre-run only, so a Run already going may overshoot. */
export function budgetBanner(report: AgentBudgetReport | null): string | null {
  if (!report?.exceeded || !report.denial) return null;
  const used = report.denial.limit === "maxTokensPerDay"
    ? `${report.usage.totalTokens.toLocaleString()} of ${report.denial.limitValue.toLocaleString()} tokens`
    : `$${report.usage.estimatedCostUsd.toFixed(4)} of $${report.denial.limitValue} estimated spend`;
  return `Daily budget reached: ${used} in the last 24 h. New runs are refused until older usage leaves the rolling window (a run that already started can still finish).`;
}
