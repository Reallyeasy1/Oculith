// ponytail: one runnable check for the quick-filter predicates. Run from repo root:
//   npx vitest run apps/web/src/runs-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { RunListItem, TraceStatus } from "./types";
import { matchesFilter, needsAttention } from "./runs-view-model";

function run(status: TraceStatus, degraded = false): RunListItem {
  return {
    runId: "r", traceId: "t", agentId: "a", agentName: "A", status, eventCount: 0, runtime: "x", model: "y",
    degraded, truncated: false, evicted: false, redacted: false,
  };
}

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
