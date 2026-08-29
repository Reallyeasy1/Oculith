// ponytail: one runnable check for the quick-filter predicates. Run from repo root:
//   npx vitest run apps/web/src/runs-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { RunListItem, TraceStatus } from "./types";
import { ERROR_HEAD_CHARS, collapseRequestId, errorHead, evidenceBadges, formatCost, formatRunDuration, formatUsage, liveRuns, matchesFilter, matchesProvenance, matchesTaskOutcome, needsAttention, outlierLabel, pluralize, recoveredFailures, runOutlier, SESSION_INPUT_TOKENS_ADVISORY_THRESHOLD, sessionHealth, summarizeRuns, taskOutcomeChip, workspaceLabel, workspaceOptionLabel } from "./runs-view-model";

function run(status: TraceStatus, degraded = false, agentId = "a", agentName = "A", extra: Partial<RunListItem> = {}): RunListItem {
  return {
    runId: "r", traceId: "t", agentId, agentName, status, eventCount: 0, runtime: "x", model: "y", toolCalls: 0, toolFailures: 0,
    capabilities: { model: "unknown", tool: "unknown" }, denials: 0, actions: 0, executionStatus: "running", taskOutcome: "unknown", degraded, truncated: false, evicted: false, redacted: false, ...extra,
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

  it("counts ok Runs with tool failures or denials as recovered — pure recovery is not attention (#131, #202)", () => {
    const runs = [run("ok", false, "a", "A", { toolFailures: 2 }), run("ok", false, "a", "A", { denials: 1 }), run("ok"), run("error", false, "a", "A", { toolFailures: 1 })];
    const s = summarizeRuns(runs);
    expect([s.ok, s.recovered, s.attention]).toEqual([3, 2, 2]);
    expect(s.agents).toEqual([{ agentId: "a", name: "A", count: 4, attention: 2 }]);
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

  it("does not flag pure recovery: an ok Run whose tool failures preceded success is informational (#202)", () => {
    expect(needsAttention(run("ok", false, "a", "A", { toolFailures: 2 }))).toBe(false);
    expect(matchesFilter(run("ok", false, "a", "A", { toolFailures: 2 }), "attention")).toBe(false);
    expect(matchesFilter(run("ok", false, "a", "A", { toolFailures: 2 }), "failed")).toBe(false);
    // The chip evidence survives even though the Run left the attention filter.
    expect(recoveredFailures(run("ok", false, "a", "A", { toolFailures: 2 }))).toBe(2);
  });

  it("still flags tool failures on a Run that has not ended ok, and denials on any status (#131, #202)", () => {
    expect(needsAttention(run("ok", false, "a", "A", { denials: 1 }))).toBe(true);
    expect(needsAttention(run("running", false, "a", "A", { toolFailures: 1 }))).toBe(true);
    expect(needsAttention(run("error", false, "a", "A", { toolFailures: 1 }))).toBe(true);
  });

  it("flags an ok Run when the agent reports failure in its final message", () => {
    const reported = run("ok", false, "a", "A", { outcome: { finalMessageBytes: 20, reportedFailure: true } });
    expect(needsAttention(reported)).toBe(true);
    expect(matchesFilter(reported, "attention")).toBe(true);
  });

  it("includes a denial even when the Run reached an otherwise successful terminal state", () => {
    const denied = { ...run("ok"), denials: 1 };
    expect(needsAttention(denied)).toBe(true);
    expect(matchesFilter(denied, "attention")).toBe(true);
  });

  it("keeps the specific filters exact", () => {
    expect(matchesFilter(run("error"), "failed")).toBe(true);
    expect(matchesFilter(run("timeout"), "failed")).toBe(false);
    expect(matchesFilter(run("ok", true), "degraded")).toBe(true);
    expect(matchesFilter(run("unset"), "all")).toBe(true);
  });
});

describe("formatUsage", () => {
  it("keeps small usage exact and compacts wide token counts", () => {
    expect(formatUsage({ inputTokens: 37384, cachedInputTokens: 12_400, outputTokens: 383 })).toBe("37k in · 12k cached · 383 out");
    expect(formatUsage({ inputTokens: 999, outputTokens: 1200 })).toBe("999 in · 1.2k out");
    expect(formatUsage({ inputTokens: 2_100_000, outputTokens: 0 })).toBe("2.1M in · 0 out");
  });
});

describe("sessionHealth (#257)", () => {
  const turn = (sessionId: string | undefined, inputTokens?: number) =>
    run("ok", false, "a", "A", { ...(sessionId ? { sessionId } : {}), ...(inputTokens === undefined ? {} : { usage: { inputTokens } }) });

  it("is empty with no thread or no Runs on the thread", () => {
    expect(sessionHealth([turn("thr-other", 50)], null)).toEqual({ turns: 0, inputTokens: 0, advisory: false });
    expect(sessionHealth([], "thr-1")).toEqual({ turns: 0, inputTokens: 0, advisory: false });
    expect(sessionHealth([turn("thr-other", 50), turn(undefined, 50)], "thr-1")).toEqual({ turns: 0, inputTokens: 0, advisory: false });
  });

  it("counts only the current thread's Runs and sums their input tokens; missing usage counts as 0", () => {
    const runs = [turn("thr-1", 100), turn("thr-other", 9_999), turn("thr-1"), turn(undefined, 42), turn("thr-1", 25)];
    expect(sessionHealth(runs, "thr-1")).toEqual({ turns: 3, inputTokens: 125, advisory: false });
  });

  it("turns advisory exactly at the cumulative input-token threshold", () => {
    expect(sessionHealth([turn("thr-1", SESSION_INPUT_TOKENS_ADVISORY_THRESHOLD - 1)], "thr-1").advisory).toBe(false);
    expect(sessionHealth([turn("thr-1", SESSION_INPUT_TOKENS_ADVISORY_THRESHOLD - 1), turn("thr-1", 1)], "thr-1").advisory).toBe(true);
  });
});

describe("runOutlier", () => {
  const baseline = { sampleCount: 20, windowSize: 20 as const, durationMs: { p50: 2_000, p95: 5_000 }, inputTokens: { p50: 100 }, toolCalls: { p50: 2 }, toolFailures: { p50: 0 } };

  it("flags values above three times the p50 and reports the exact multiple", () => {
    const outlier = runOutlier(run("ok", false, "a", "A", { durationMs: 6_001, usage: { inputTokens: 1_100 } }), baseline);
    expect(outlier).toEqual({ durationMultiple: 3.0005, inputTokensMultiple: 11 });
    expect(outlierLabel(outlier!)).toBe("outlier ×11 tokens");
  });

  it("shows no chip with fewer than three Runs, missing/zero p50s, or exactly three times", () => {
    expect(runOutlier(run("ok", false, "a", "A", { durationMs: 10_000 }), { ...baseline, sampleCount: 2 })).toBeUndefined();
    expect(runOutlier(run("ok", false, "a", "A", { durationMs: 6_000 }), baseline)).toBeUndefined();
    expect(runOutlier(run("ok", false, "a", "A", { durationMs: 10_000 }), { ...baseline, durationMs: { p50: 0 } })).toBeUndefined();
  });

  it("formats optional estimated cost without pretending at high precision", () => {
    expect(formatCost(0.001234)).toBe("$0.0012");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(undefined)).toBe("—");
  });
});

describe("formatRunDuration", () => {
  it("renders restart time as a lower bound and keeps the last evidence offset", () => {
    expect(formatRunDuration(52, "server_restart", 61_000)).toBe("≥ 1m 01s · interrupted (last evidence +52 ms)");
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

describe("workspace presentation", () => {
  it("hides managed workspace UUIDs while retaining them as tooltip evidence", () => {
    expect(workspaceLabel("agent-uuid", "agent-uuid")).toEqual({ text: "managed", title: "agent-uuid" });
    expect(workspaceLabel("shared-repo", "agent-uuid")).toEqual({ text: "shared-repo" });
    expect(workspaceLabel(undefined, "agent-uuid")).toEqual({ text: "—" });
  });

  it("describes selectable workspaces with sharing and file-count context", () => {
    expect(workspaceOptionLabel({ name: "shared-repo", path: "/work/shared-repo", agents: ["a", "b"], fileCount: 7, lastModified: "2026-08-27T00:00:00Z", managed: false }))
      .toBe("shared-repo · 2 agents · unmanaged · 7 files");
  });
});

describe("error de-duplication presentation (#263)", () => {
  // Shaped like the trace-34910180 repro: the provider echoes the same request id twice.
  const provider = "Provider rejected the request: 401 Unauthorized, invalid API key (request id: req-2026082716-abc123). Upstream said: unauthorized · request id: req-2026082716-abc123";

  it("collapses a repeated request id, keeping the first occurrence", () => {
    const collapsed = collapseRequestId(provider);
    expect(collapsed.match(/request id/gi)).toHaveLength(1);
    expect(collapsed).toContain("(request id: req-2026082716-abc123)");
    expect(collapsed).toContain("Upstream said: unauthorized");
  });

  it("is idempotent and case-insensitive on the label", () => {
    const once = collapseRequestId("boom Request id: r-1 and again request id: r-1");
    expect(once).toBe("boom Request id: r-1 and again");
    expect(collapseRequestId(once)).toBe(once);
  });

  it("keeps distinct request ids and untouched text alone", () => {
    expect(collapseRequestId("a request id: r-1, b request id: r-2")).toBe("a request id: r-1, b request id: r-2");
    expect(collapseRequestId("no ids here")).toBe("no ids here");
  });

  it("bounds errorHead at ERROR_HEAD_CHARS plus one ellipsis, leaving short text alone", () => {
    const head = errorHead(provider);
    expect(head.length).toBeLessThanOrEqual(ERROR_HEAD_CHARS + 1);
    expect(head.endsWith("…")).toBe(true);
    expect(errorHead("short error")).toBe("short error");
    expect(errorHead("x".repeat(ERROR_HEAD_CHARS))).toBe("x".repeat(ERROR_HEAD_CHARS));
  });

  it("pluralizes counts, including the irregular retry/retries", () => {
    expect(pluralize(1, "model call")).toBe("1 model call");
    expect(pluralize(2, "model call")).toBe("2 model calls");
    expect(pluralize(0, "tool call")).toBe("0 tool calls");
    expect(pluralize(1, "retry", "retries")).toBe("1 retry");
    expect(pluralize(3, "retry", "retries")).toBe("3 retries");
  });
});

describe("evidenceBadges", () => {
  it("calls out a successful Run with zero tools without implying missing evidence", () => {
    expect(evidenceBadges(run("ok"))).toEqual([
      expect.objectContaining({ label: "no tool calls", warn: false }),
    ]);
  });

  it("names only unknown layers on ended Runs", () => {
    expect(evidenceBadges(run("cancelled", false, "a", "A", {
      capabilities: { model: "unknown", tool: "observed" },
    }))).toEqual([expect.objectContaining({ label: "model: no evidence", warn: true })]);
    expect(evidenceBadges(run("timeout"))).toEqual([
      expect.objectContaining({ label: "model: no evidence" }),
      expect.objectContaining({ label: "tool: no evidence" }),
    ]);
  });

  it("does not warn about evidence while a Run is still live", () => {
    expect(evidenceBadges(run("running"))).toEqual([]);
  });
});

describe("taskOutcome filter + chip (#173)", () => {
  it("matches on the taskOutcome axis independently of status", () => {
    expect(matchesTaskOutcome(run("ok", false, "a", "A", { taskOutcome: "failed" }), "failed")).toBe(true);
    expect(matchesTaskOutcome(run("error", false, "a", "A", { taskOutcome: "failed" }), "failed")).toBe(true);
    expect(matchesTaskOutcome(run("ok", false, "a", "A", { taskOutcome: "passed" }), "failed")).toBe(false);
    expect(matchesTaskOutcome(run("ok"), "unknown")).toBe(true);
    for (const outcome of ["passed", "failed", "unknown"] as const) expect(matchesTaskOutcome(run("ok", false, "a", "A", { taskOutcome: outcome }), "all")).toBe(true);
  });

  it("chips passed and failed verdicts; unknown is no claim, not a chip", () => {
    expect(taskOutcomeChip(run("ok", false, "a", "A", { taskOutcome: "passed" }))).toEqual({ label: "task passed", warn: false });
    expect(taskOutcomeChip(run("ok", false, "a", "A", { taskOutcome: "failed" }))).toEqual({ label: "task failed", warn: true });
    expect(taskOutcomeChip(run("ok"))).toBeUndefined();
  });
});

describe("provenance drill-back (#174)", () => {
  it("shows exactly the Run ids behind a comparison cell", () => {
    expect(matchesProvenance(run("ok", false, "a", "A", { runId: "a" }), ["a", "b"])).toBe(true);
    expect(matchesProvenance(run("ok", false, "c", "C", { runId: "c" }), ["a", "b"])).toBe(false);
    expect(matchesProvenance(run("ok", false, "c", "C", { runId: "c" }), undefined)).toBe(true);
  });
});
