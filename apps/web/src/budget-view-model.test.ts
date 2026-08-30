import { describe, expect, it } from "vitest";
import { budgetBanner } from "./budget-view-model";
import type { AgentBudgetReport } from "./types";

const report = (over: Partial<AgentBudgetReport>): AgentBudgetReport => ({
  budget: { maxTokensPerDay: 1000 },
  usage: { totalTokens: 1200, estimatedCostUsd: 0.8, runs: 3, windowStart: "2026-08-28T12:00:00.000Z" },
  exceeded: true,
  denial: { decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: 1000, used: 1200 },
  ...over,
});

describe("budgetBanner (#255)", () => {
  it("hides when there is no budget or the Agent is under it", () => {
    expect(budgetBanner(null)).toBeNull();
    expect(budgetBanner(report({ exceeded: false, denial: undefined }))).toBeNull();
  });
  it("names the token limit and both sides of the comparison", () => {
    const text = budgetBanner(report({}));
    expect(text).toContain("tokens");
    expect(text).toContain("refused");
  });
  it("shows dollars for the USD limit", () => {
    const text = budgetBanner(report({
      budget: { maxEstimatedUsdPerDay: 0.5 },
      denial: { decision: "budget_exceeded", limit: "maxEstimatedUsdPerDay", limitValue: 0.5, used: 0.8 },
    }));
    expect(text).toContain("$0.8000 of $0.5");
  });
});
