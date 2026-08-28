// ponytail: one runnable check for the create/save payload. Run from repo root:
//   npx vitest run apps/web/src/agent-form.test.ts
import { describe, expect, it } from "vitest";
import { agentPayload } from "./agent-form";

const form = { name: "Builder", description: "", instructions: "Help", workspace: "", template: "", verifyCommand: "" };

describe("agentPayload", () => {
  it("omits empty workspace and template so the default Create Agent is not a 400", () => {
    expect(agentPayload(form, { template: true })).toEqual({ name: "Builder", description: "", instructions: "Help", verifyCommand: "" });
  });
  it("sends the chosen workspace and template on create, never the template on save", () => {
    const chosen = { ...form, workspace: "shared-repo", template: "node-lib-with-failing-test" };
    expect(agentPayload(chosen, { template: true })).toMatchObject({ workspace: "shared-repo", template: "node-lib-with-failing-test" });
    expect(agentPayload(chosen, { template: false })).toEqual({ name: "Builder", description: "", instructions: "Help", workspace: "shared-repo", verifyCommand: "" });
  });
  it("always sends verifyCommand — an empty string clears the stored command on save (#253)", () => {
    expect(agentPayload({ ...form, verifyCommand: "npm test" }, { template: false })).toMatchObject({ verifyCommand: "npm test" });
    expect(agentPayload(form, { template: false })).toMatchObject({ verifyCommand: "" });
  });
});
