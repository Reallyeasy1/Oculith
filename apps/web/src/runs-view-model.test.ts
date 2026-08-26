// ponytail: one runnable check for the quick-filter predicates. Run from repo root:
//   npx vitest run apps/web/src/runs-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { RunListItem, TraceStatus } from "./types";
import { matchesFilter, needsAttention, summarizeRuns } from "./runs-view-model";

function run(status: TraceStatus, degraded = false, agentId = "a", agentName = "A"): RunListItem {
  return {
    runId: "r", traceId: "t", agentId, agentName, status, eventCount: 0, runtime: "x", model: "y", toolCalls: 0, toolFailures: 0,
    capabilities: { model: "unknown", tool: "unknown" }, denials: 0, degraded, truncated: false, evicted: false, redacted: false,
  };
}

describe("summarizeRuns", () => {
  it("counts only the API's status/degraded fields, per Agent and overall", () => {
    const runs = [
      run("ok"), run("ok", true), run("error"),
      run("running", false, "b", "B"), run("timeout", false, "b", "B"), run("cancelled", false, "b", "B"),
    ];
    expect(summarizeRuns(runs)).toEqual({
      total: 6, ok: 2, attention: 4, running: 1,
      agents: [
        { agentId: "a", name: "A", count: 3, attention: 2 },
        { agentId: "b", name: "B", count: 3, attention: 2 },
      ],
    });
  });

  it("is all zeros with no Agents for an empty list, and falls back to the agentId as a name", () => {
    expect(summarizeRuns([])).toEqual({ total: 0, ok: 0, attention: 0, running: 0, agents: [] });
    expect(summarizeRuns([run("unset", false, "z", "")]).agents).toEqual([{ agentId: "z", name: "z", count: 1, attention: 0 }]);
  });
});

describe("needsAttention", () => {
  it.each<[TraceStatus, boolean, boolean]>([
    ["error", false, true],
    ["timeout", false, true],
    ["cancelled", false, true],
    ["ok", true, true],
    ["running", true, true],
    ["ok", false, false],
    ["running", false, false],
    ["unset", false, false],
  ])("%s degraded=%s → %s", (status, degraded, expected) => {
    expect(needsAttention(run(status, degraded))).toBe(expected);
    expect(matchesFilter(run(status, degraded), "attention")).toBe(expected);
  });

  it("keeps the specific filters exact", () => {
    expect(matchesFilter(run("error"), "failed")).toBe(true);
    expect(matchesFilter(run("timeout"), "failed")).toBe(false);
    expect(matchesFilter(run("ok", true), "degraded")).toBe(true);
    expect(matchesFilter(run("unset"), "all")).toBe(true);
  });
});
