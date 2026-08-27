import { describe, expect, it } from "vitest";
import { caseFromRun, prefillAssertions } from "./cases.js";
import type { TraceView } from "../glassbox/query.js";

const view = { summary: { status: "ok", durationMs: 100, }, events: [
  { category: "tool", type: "tool.call.completed", spanId: "tool-1", attributes: { program: "npm" } },
] } as unknown as TraceView;

describe("regression case prefill", () => {
  it("derives bounded assertions from a successful trace", () => {
    expect(prefillAssertions(view)).toEqual([
      { type: "terminal_status", expected: "ok" }, { type: "expected_tool", program: "npm" },
      { type: "max_tool_calls", max: 2 }, { type: "max_duration_ms", max: 150 },
    ]);
    expect(caseFromRun({ id: "run", prompt: "check it", configHash: "hash" } as never, view, "fixture")).toMatchObject({ workspaceTemplate: "fixture", baselineConfigHash: "hash" });
  });

  it("refuses a failed run as a baseline", () => {
    expect(() => caseFromRun({ id: "run", prompt: "x", configHash: "hash" } as never, { ...view, summary: { ...view.summary, status: "error" } }, "fixture")).toThrow("Only successful");
  });
});
