// ponytail: one runnable check for the create/save payload. Run from repo root:
//   npx vitest run apps/web/src/agent-form.test.ts
import { describe, expect, it } from "vitest";
import { agentPayload, budgetFormError, budgetPayload } from "./agent-form";

const form = { name: "Builder", description: "", instructions: "Help", workspace: "", template: "", verifyCommand: "", maxTokensPerDay: "", maxEstimatedUsdPerDay: "" };

describe("agentPayload", () => {
  it("omits empty workspace and template so the default Create Agent is not a 400", () => {
    expect(agentPayload(form, { template: true })).toEqual({ name: "Builder", description: "", instructions: "Help", verifyCommand: "", budget: null });
  });
  it("sends the chosen workspace and template on create, never the template on save", () => {
    const chosen = { ...form, workspace: "shared-repo", template: "node-lib-with-failing-test" };
    expect(agentPayload(chosen, { template: true })).toMatchObject({ workspace: "shared-repo", template: "node-lib-with-failing-test" });
    expect(agentPayload(chosen, { template: false })).toEqual({ name: "Builder", description: "", instructions: "Help", workspace: "shared-repo", verifyCommand: "", budget: null });
  });
  it("always sends verifyCommand — an empty string clears the stored command on save (#253)", () => {
    expect(agentPayload({ ...form, verifyCommand: "npm test" }, { template: false })).toMatchObject({ verifyCommand: "npm test" });
    expect(agentPayload(form, { template: false })).toMatchObject({ verifyCommand: "" });
  });
});

describe("budgetPayload (#255)", () => {
  it("sends only valid positive limits and null when both fields are blank (clears the budget)", () => {
    expect(budgetPayload({ maxTokensPerDay: "10000", maxEstimatedUsdPerDay: "" })).toEqual({ maxTokensPerDay: 10_000 });
    expect(budgetPayload({ maxTokensPerDay: "", maxEstimatedUsdPerDay: "1.50" })).toEqual({ maxEstimatedUsdPerDay: 1.5 });
    expect(budgetPayload({ maxTokensPerDay: "", maxEstimatedUsdPerDay: "" })).toBeNull();
  });
  it("treats zero, negatives, fractions of a token, and junk as 'no limit'", () => {
    expect(budgetPayload({ maxTokensPerDay: "0", maxEstimatedUsdPerDay: "-1" })).toBeNull();
    expect(budgetPayload({ maxTokensPerDay: "1.5", maxEstimatedUsdPerDay: "abc" })).toBeNull();
  });
});

describe("budgetFormError (#255)", () => {
  it("accepts blanks and valid limits", () => {
    expect(budgetFormError({ maxTokensPerDay: "", maxEstimatedUsdPerDay: "" })).toBeNull();
    expect(budgetFormError({ maxTokensPerDay: "100", maxEstimatedUsdPerDay: "0.5" })).toBeNull();
  });
  it("refuses the submit for input that budgetPayload would coerce into 'no limit'", () => {
    expect(budgetFormError({ maxTokensPerDay: "1.5", maxEstimatedUsdPerDay: "" })).toMatch(/whole number/);
    expect(budgetFormError({ maxTokensPerDay: "", maxEstimatedUsdPerDay: "-2" })).toMatch(/above zero/);
    expect(budgetFormError({ maxTokensPerDay: "abc", maxEstimatedUsdPerDay: "" })).toBeTruthy();
  });
});
