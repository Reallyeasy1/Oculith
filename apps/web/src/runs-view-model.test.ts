// ponytail: one runnable check for the quick-filter predicates. Run from repo root:
//   npx vitest run apps/web/src/runs-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { RunListItem, TraceStatus } from "./types";
import { liveRuns, matchesFilter, needsAttention, recoveredFailures, summarizeRuns } from "./runs-view-model";

function run(status: TraceStatus, degraded = false, agentId = "a", agentName = "A", extra: Partial<RunListItem> = {}): RunListItem {
  return {
    runId: "r", traceId: "t", agentId, agentName, status, eventCount: 0, runtime: "x", model: "y", toolCalls: 0, toolFailures: 0,
    capabilities: { model: "unknown", tool: "unknown" }, denials: 0, degraded, truncated: false, evicted: false, redacted: false, ...extra,
  };
}

describe("summarizeRuns", () => {
  it("counts only the API's status/degraded fields, per Agent and overall", () => {
    const runs = [
      run("ok"), run("ok", true), run("error"),
      run("running", false, "b", "B"), run("timeout", false, "b", "B"), run("cancelled", false, "b", "B"),
    ];
    expect(summarizeRuns(runs)).toEqual({
      total: 6, ok: 2, attention: 4, running: 1, recovered: 0,
      agents: [
        { agentId: "a", name: "A", count: 3, attention: 2 },
        { agentId: "b", name: "B", count: 3, attention: 2 },
      ],
    });
  });

  it("counts ok Runs with tool failures or denials as recovered — and as needing attention (#131)", () => {
    const runs = [run("ok", false, "a", "A", { toolFailures: 2 }), run("ok", false, "a", "A", { denials: 1 }), run("ok"), run("error", false, "a", "A", { toolFailures: 1 })];
    const s = summarizeRuns(runs);
    expect([s.ok, s.recovered, s.attention]).toEqual([3, 2, 3]);
    expect(s.agents).toEqual([{ agentId: "a", name: "A", count: 4, attention: 3 }]);
  });

  it("is all zeros with no Agents for an empty list, and falls back to the agentId as a name", () => {
    expect(summarizeRuns([])).toEqual({ total: 0, ok: 0, attention: 0, running: 0, recovered: 0, agents: [] });
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

  it("flags tool failures and denials on any status (#131)", () => {
    expect(needsAttention(run("ok", false, "a", "A", { toolFailures: 2 }))).toBe(true);
    expect(needsAttention(run("ok", false, "a", "A", { denials: 1 }))).toBe(true);
    expect(needsAttention(run("running", false, "a", "A", { toolFailures: 1 }))).toBe(true);
    expect(matchesFilter(run("ok", false, "a", "A", { toolFailures: 2 }), "attention")).toBe(true);
    expect(matchesFilter(run("ok", false, "a", "A", { toolFailures: 2 }), "failed")).toBe(false);
  });

  it("keeps the specific filters exact", () => {
    expect(matchesFilter(run("error"), "failed")).toBe(true);
    expect(matchesFilter(run("timeout"), "failed")).toBe(false);
    expect(matchesFilter(run("ok", true), "degraded")).toBe(true);
    expect(matchesFilter(run("unset"), "all")).toBe(true);
  });
});

describe("recoveredFailures", () => {
  it("sums tool failures and denials only for ok Runs", () => {
    expect(recoveredFailures(run("ok", false, "a", "A", { toolFailures: 2, denials: 1 }))).toBe(3);
    expect(recoveredFailures(run("ok"))).toBe(0);
    expect(recoveredFailures(run("error", false, "a", "A", { toolFailures: 2 }))).toBe(0);
    expect(recoveredFailures(run("running", false, "a", "A", { denials: 1 }))).toBe(0);
  });
});

describe("liveRuns", () => {
  it("keeps only running Runs, newest first, regardless of degraded/failures", () => {
    const older = run("running", true, "a", "A", { runId: "old", startedAt: "2026-08-27T10:00:00Z" });
    const newer = run("running", false, "b", "B", { runId: "new", startedAt: "2026-08-27T10:05:00Z", toolFailures: 1 });
    expect(liveRuns([run("ok"), older, run("error"), newer]).map((r) => r.runId)).toEqual(["new", "old"]);
    expect(liveRuns([run("ok"), run("error")])).toEqual([]);
  });
});
