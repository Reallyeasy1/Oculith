import type { AgentBudget } from "../types.js";
import type { RunSummary } from "./summary.js";

/** #255: "per day" is a rolling 24 h window ending now, not a calendar day — no timezone questions. */
export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export const budgetWindowStart = (now: Date = new Date()): string =>
  new Date(now.getTime() - BUDGET_WINDOW_MS).toISOString();

/** Observed spend inside the window, summed over terminal Runs only (a running Run has no turn-end usage yet). */
export interface BudgetUsage {
  totalTokens: number;
  estimatedCostUsd: number;
  runs: number;
  windowStart: string;
}

/**
 * Sums what the rollups actually recorded — the same figures the Runs list and baseline show.
 * `cachedInputTokens` is a subset of `inputTokens` and reasoning a subset of output (see cost.ts),
 * so totalTokens is input + output and nothing is counted twice.
 */
export function usageInWindow(summaries: RunSummary[], windowStart: string): BudgetUsage {
  const usage: BudgetUsage = { totalTokens: 0, estimatedCostUsd: 0, runs: 0, windowStart };
  for (const summary of summaries) {
    if (summary.executionStatus === "running") continue;
    if ((summary.startedAt ?? "") < windowStart) continue;
    const input = summary.usage?.inputTokens ?? summary.metrics.tokens?.input ?? 0;
    const output = summary.usage?.outputTokens ?? summary.metrics.tokens?.output ?? 0;
    usage.totalTokens += input + output;
    usage.estimatedCostUsd += summary.estimatedCostUsd ?? 0;
    usage.runs += 1;
  }
  return usage;
}

export interface BudgetDenial {
  decision: "budget_exceeded";
  limit: "maxTokensPerDay" | "maxEstimatedUsdPerDay";
  limitValue: number;
  used: number;
}

/**
 * Pre-run gate only (#255 honesty constraint): Codex reports usage at turn end, so a Run that is
 * already going cannot be preempted and a single Run can overshoot the cap. The gate stops the
 * *next* Run once recorded usage has reached a limit.
 */
export function evaluateBudget(budget: AgentBudget, usage: BudgetUsage): BudgetDenial | undefined {
  if (budget.maxTokensPerDay !== undefined && usage.totalTokens >= budget.maxTokensPerDay) {
    return { decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: budget.maxTokensPerDay, used: usage.totalTokens };
  }
  if (budget.maxEstimatedUsdPerDay !== undefined && usage.estimatedCostUsd >= budget.maxEstimatedUsdPerDay) {
    return { decision: "budget_exceeded", limit: "maxEstimatedUsdPerDay", limitValue: budget.maxEstimatedUsdPerDay, used: usage.estimatedCostUsd };
  }
  return undefined;
}

/** Drops unset fields; `null` or a budget with no limits normalizes to undefined ("no budget"). */
export function normalizeBudget(budget: AgentBudget | null | undefined): AgentBudget | undefined {
  if (!budget) return undefined;
  const next: AgentBudget = {
    ...(budget.maxTokensPerDay !== undefined ? { maxTokensPerDay: budget.maxTokensPerDay } : {}),
    ...(budget.maxEstimatedUsdPerDay !== undefined ? { maxEstimatedUsdPerDay: budget.maxEstimatedUsdPerDay } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

export function describeBudgetDenial(denial: BudgetDenial): string {
  return denial.limit === "maxTokensPerDay"
    ? `Budget exceeded: this Agent used ${denial.used} tokens in the last 24 h (limit ${denial.limitValue}). New Runs are refused until usage falls below the cap.`
    : `Budget exceeded: this Agent's estimated spend in the last 24 h is $${denial.used.toFixed(4)} (limit $${denial.limitValue}). New Runs are refused until usage falls below the cap.`;
}
