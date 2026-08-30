// ponytail: one runnable check for the tree/filter logic. Web has no test script; run from repo root with
//   npx vitest run apps/web/src/trace-view-model.test.ts
// (vitest is hoisted from the server workspace — no new dependency.)
import { describe, expect, it } from "vitest";
import type { Span, TraceView } from "./types";
import { ACTORS_TOOLTIP, EMPTY_FILTER, barGeometry, capabilityBadgeLabel, capabilityCopy, coalesceErrorRows, defaultExpanded, firstFailedSpanId, formatActors, formatAuditActor, formatReasoningTokens, interruptedSpanDurationMs, matchesSpan, refreshIntervalMs, spanArgument, spanStatusLabel, timelineTicks, trimDiagnosis, visibleRows, type VisibleRow } from "./trace-view-model";

const t0 = "2026-08-26T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();

function span(id: string, over: Partial<Span> = {}): Span {
  return {
    spanId: id, name: id, category: "control", status: "ok", startedAt: t0, durationMs: 100, incomplete: false,
    sequence: 0, source: { component: "test", observed: true }, attributes: {}, events: [], children: [], depth: 0, ...over,
  };
}

// root ─┬─ a ─── a1 (error)
//       └─ b ─┬─ b1
//             └─ b2
const a1 = span("a1", { status: "error", depth: 2, parentSpanId: "a", error: { type: "E", message: "boom" }, category: "runtime", startedAt: at(500), durationMs: 200 });
const a = span("a", { depth: 1, parentSpanId: "root", children: [a1] });
const b1 = span("b1", { depth: 2, parentSpanId: "b" });
const b2 = span("b2", { depth: 2, parentSpanId: "b", category: "tool" });
const b = span("b", { depth: 1, parentSpanId: "root", children: [b1, b2] });
const root = span("root", { children: [a, b], durationMs: 1000 });

const view: TraceView = {
  summary: {
    schemaVersion: "1.0", capturePolicy: "metadata_only", runId: "r", traceId: "t", agentId: "ag", status: "error",
    startedAt: t0, durationMs: 1000, eventCount: 0, spanCount: 6, incompleteSpans: 0, redactedEvents: 0, degraded: false,
    denials: 0, audit: { actions: 0, denials: 0, actors: [] }, truncated: false, evicted: false, metrics: { terminalStatus: "error", toolCalls: 0, toolFailures: 0, modelCalls: 0, timeSplit: { modelMs: 0, toolMs: 0, containerStartMs: 0 }, retries: 0, denials: 0 }, capabilities: { model: "unavailable", tool: "unavailable" },
    failure: { kind: "error", spanId: "a1", eventId: "e", sequence: 3, name: "a1", category: "runtime", component: "test", path: ["root", "a", "a1"], diagnosis: "x" },
  },
  spans: [root],
  events: [],
};

describe("trace-view-model", () => {
  it("formats observed reasoning tokens without fabricating missing evidence", () => {
    expect(formatReasoningTokens({ reasoning: 12_400 })).toBe("12k reasoning tokens");
    expect(formatReasoningTokens(undefined)).toBe("");
  });

  it("formats audit actors in the short kind · shortId form, full list in the title (#250, #341)", () => {
    expect(formatActors({ actions: 0, denials: 0, actors: [] })).toEqual({ text: "—", title: ACTORS_TOOLTIP });
    expect(formatActors({ actions: 5, denials: 0, actors: ["agent/agt-1", "human/local-user"] }))
      .toEqual({ text: "agent · agt-1 · human · local-user", title: `${ACTORS_TOOLTIP} All actors: agent/agt-1 · human/local-user` });
    // Long UUID-ish ids collapse to the #338 short form; the full id survives only in the title.
    const uuid = formatActors({ actions: 2, denials: 0, actors: ["agent/agt-0123456789abcdef0123456789abcdef"] });
    expect(uuid.text).toBe("agent · agt-0123…");
    expect(uuid.title).toBe(`${ACTORS_TOOLTIP} All actors: agent/agt-0123456789abcdef0123456789abcdef`);
    expect(formatActors({ actions: 5, denials: 3, actors: ["agent/agt-1", "service/runner"] }).text)
      .toBe("agent · agt-1 · service · runner · 3 denied");
    const many = formatActors({ actions: 9, denials: 1, actors: ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6"] });
    expect(many.text).toBe("a · 1 · b · 2 · c · 3 · d · 4 · … · 1 denied");
    expect(many.title).toBe(`${ACTORS_TOOLTIP} All actors: a/1 · b/2 · c/3 · d/4 · e/5 · f/6`);
  });

  it("keeps terminal evidence labels short and layer-specific", () => {
    expect(capabilityCopy("unknown", "cancelled").label).toBe("no evidence");
    expect(capabilityBadgeLabel("model", "unknown", "cancelled")).toBe("model: no evidence");
    expect(capabilityBadgeLabel("tool", "observed", "ok")).toBe("tool observed");
    expect(capabilityBadgeLabel("model", "unknown", "running")).toBe("model pending");
    expect(capabilityBadgeLabel("tool", "unknown", "ok")).toBe("tool: no evidence"); // reachable: chat-only ok Run
  });

  it("expands a small successful trace completely but keeps large traces bounded", () => {
    const small = { ...view, summary: { ...view.summary, spanCount: 6, failure: undefined } };
    expect(defaultExpanded(small).size).toBe(6);
    const large = { ...view, summary: { ...view.summary, spanCount: 41, failure: undefined } };
    expect(defaultExpanded(large)).toEqual(new Set(["root"]));
  });
  it("expands every small trace by default", () => {
    const expanded = defaultExpanded(view);
    expect([...expanded].sort()).toEqual(["a", "a1", "b", "b1", "b2", "root"]);
    const ids = visibleRows(view.spans, expanded, EMPTY_FILTER).map((r) => r.span.spanId);
    expect(ids).toEqual(["root", "a", "a1", "b", "b1", "b2"]);
  });

  it("keeps ancestors as context and auto-expands when a filter is active", () => {
    const rows = visibleRows(view.spans, new Set(["root"]), { ...EMPTY_FILTER, errorsOnly: true });
    expect(rows.map((r) => [r.span.spanId, r.context])).toEqual([["root", true], ["a", true], ["a1", false]]);
    const tool = visibleRows(view.spans, new Set(), { ...EMPTY_FILTER, category: "tool" }).map((r) => r.span.spanId);
    expect(tool).toEqual(["root", "b", "b2"]);
    expect(visibleRows(view.spans, new Set(), { ...EMPTY_FILTER, text: "nope" })).toEqual([]);
  });

  it("free-text matches name, id, component and error message", () => {
    expect(matchesSpan(a1, { ...EMPTY_FILTER, text: "BOOM" })).toBe(true);
    expect(matchesSpan(b1, { ...EMPTY_FILTER, text: "boom" })).toBe(false);
    expect(matchesSpan(b1, { ...EMPTY_FILTER, status: "error" })).toBe(false);
  });

  it("bar geometry is relative to the run duration", () => {
    expect(barGeometry(a1, view, a)).toEqual({
      left: 50,
      width: 20,
      startOffsetMs: 500,
      durationMs: 200,
      instant: false,
      openEnded: false,
      endsAfterParent: true,
    });
    expect(barGeometry(root, { ...view, summary: { ...view.summary, durationMs: undefined } })).toBeUndefined();
  });

  it("keeps unknown capabilities pending until a Run has ended", () => {
    expect(capabilityCopy("unknown", "running").label).toBe("pending");
    expect(capabilityCopy("unknown", "cancelled").label).toBe("no evidence");
    expect(capabilityCopy("observed", "running").label).toBe("observed");
  });

  it("refreshes a live trace faster than terminal or unopened traces", () => {
    expect(refreshIntervalMs("running")).toBe(1_500);
    expect(refreshIntervalMs("ok")).toBe(5_000);
    expect(refreshIntervalMs(undefined)).toBe(5_000);
  });

  it("labels restart-incomplete spans interrupted and open spans in any dead Run as never closed (#341)", () => {
    const live = { status: "running" as const };
    const restart = { status: "cancelled" as const, endedReason: "server_restart" as const };
    expect(spanStatusLabel({ status: "running", incomplete: true }, restart)).toBe("interrupted");
    expect(spanStatusLabel({ status: "running", incomplete: true }, live)).toBe("running");
    expect(spanStatusLabel({ status: "cancelled", incomplete: false }, restart)).toBe("cancelled");
    // Terminal trace (any of failed/timeout/cancelled/ok) with a still-open span: never the RUNNING pill.
    for (const status of ["error", "timeout", "cancelled", "ok"] as const) {
      expect(spanStatusLabel({ status: "running", incomplete: true }, { status })).toBe("never closed");
    }
    expect(spanStatusLabel({ status: "ok", incomplete: false }, { status: "error" })).toBe("ok");
  });

  it("surfaces argument0 as the discriminator for identically named tool rows (#341)", () => {
    expect(spanArgument({ program: "powershell.exe", argument0: "-Command Get-ChildItem" })).toBe("-Command Get-ChildItem");
    expect(spanArgument({ program: "powershell.exe" })).toBe("");
    expect(spanArgument({ argument0: 7 })).toBe("");
  });

  it("trims the heading's First-actionable clause out of the diagnosis (#341)", () => {
    const failure = { kind: "timeout", name: "runtime.codex.failed" };
    expect(trimDiagnosis(
      "Run timeout in AgentRunner after 120.7 s. First actionable timeout: runtime.codex.failed — Codex run timed out after 120000 ms. Cleanup evidence: x.",
      failure,
    )).toBe("Run timeout in AgentRunner after 120.7 s. Codex run timed out after 120000 ms. Cleanup evidence: x.");
    // Without a message the whole sentence goes; following sentences survive.
    expect(trimDiagnosis("Run timeout in X after 2.0 s. First actionable timeout: runtime.codex.failed. Trace store was degraded during this Run; evidence may be incomplete.", failure))
      .toBe("Run timeout in X after 2.0 s. Trace store was degraded during this Run; evidence may be incomplete.");
    expect(trimDiagnosis("Run timeout in X after 2.0 s. First actionable timeout: runtime.codex.failed.", failure))
      .toBe("Run timeout in X after 2.0 s.");
    // A diagnosis without the clause (denied, restart) passes through untouched.
    expect(trimDiagnosis("sandbox declined `pwsh`", { kind: "denied", name: "pwsh" })).toBe("sandbox declined `pwsh`");
  });

  it("uses the restart marker as the honest lower bound for an incomplete span", () => {
    const interrupted = span("open", { startedAt: at(8_000), incomplete: true });
    expect(interruptedSpanDurationMs(interrupted, { ...view.summary, endedReason: "server_restart", endedAt: at(61_000), interruptedAfterMs: 61_000 })).toBe(53_000);
    expect(interruptedSpanDurationMs({ ...interrupted, incomplete: false }, view.summary)).toBeUndefined();
  });

  it("computes readable ticks including the exact Run duration", () => {
    expect(timelineTicks(1000)).toEqual([
      { milliseconds: 0, percent: 0 },
      { milliseconds: 250, percent: 25 },
      { milliseconds: 500, percent: 50 },
      { milliseconds: 750, percent: 75 },
      { milliseconds: 1000, percent: 100 },
    ]);
    const uneven = timelineTicks(1234);
    expect(uneven).toHaveLength(4);
    expect(uneven.at(-1)).toEqual({ milliseconds: 1234, percent: 100 });
    expect(timelineTicks(undefined)).toEqual([]);
  });

  it("drops an interior tick that would collide with the right-anchored last tick", () => {
    // 302828 ms: step 100000 puts 300000 at 99% — it must yield to the exact-end tick.
    expect(timelineTicks(302_828).map((tick) => tick.milliseconds)).toEqual([0, 100_000, 200_000, 302_828]);
    // 401 ms: step 200 puts 400 at 99.75% — same collision, smallest scale.
    expect(timelineTicks(401).map((tick) => tick.milliseconds)).toEqual([0, 200, 401]);
    // Interior ticks at or below ~92% stay (1000/1234 ≈ 81%) — covered by the uneven case above.
  });

  it("finds the first failed span in document order for the ok-Run tool-failure anchor", () => {
    expect(firstFailedSpanId(view.spans)).toBe("a1");
    const recovered = span("tool-fail", { status: "ok", error: { type: "E", message: "retryable" } });
    expect(firstFailedSpanId([span("ok-root", { children: [recovered] })])).toBe("tool-fail");
    expect(firstFailedSpanId([span("clean")])).toBeUndefined();
    expect(firstFailedSpanId([])).toBeUndefined();
  });

  it("shortens long audit actor ids to kind · shortId, keeping the full id in the title (#338)", () => {
    expect(formatAuditActor({ type: "agent", id: "agt-0123456789abcdef0123456789abcdef0123" }))
      .toEqual({ text: "agent · agt-0123…", title: "agent/agt-0123456789abcdef0123456789abcdef0123" });
    expect(formatAuditActor({ type: "human", id: "local-user" }))
      .toEqual({ text: "human · local-user", title: "human/local-user" });
  });

  it("coalesces consecutive identical leaf error rows into one ×N row (#338)", () => {
    const errRow = (id: string, message = "boom"): VisibleRow => ({
      span: span(id, { name: "retry", depth: 1, error: { type: "E", message } }),
      hasChildren: false, expanded: false, context: false,
    });
    const out = coalesceErrorRows([errRow("e1"), errRow("e2"), errRow("e3")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repeat: 3, span: { spanId: "e1" } });

    // A different message breaks the run; parents never collapse.
    const mixed = coalesceErrorRows([errRow("e1"), errRow("e2"), errRow("other", "different")]);
    expect(mixed.map((r) => [r.span.spanId, r.repeat ?? 1])).toEqual([["e1", 2], ["other", 1]]);

    expect(coalesceErrorRows([{ ...errRow("p"), hasChildren: true }, errRow("e2")])).toHaveLength(2);

    // Non-error rows pass through untouched.
    const ok: VisibleRow = { span: span("ok"), hasChildren: false, expanded: false, context: false };
    expect(coalesceErrorRows([ok, ok])).toHaveLength(2);
  });

  it("coalesces a repeating tool→policy denial pair into its first pair with ×N on both rows (#341)", () => {
    const row = (id: string, name: string, message = "operation not permitted"): VisibleRow => ({
      span: span(id, { name, depth: 2, error: { type: "E", message } }),
      hasChildren: false, expanded: false, context: false,
    });
    // The flagship pattern: 8 denials = 16 alternating tool→policy rows with identical messages.
    const pairs = Array.from({ length: 8 }, (_, i) => [row(`t${i}`, "shell:powershell.exe"), row(`p${i}`, "policy.denied")]).flat();
    const out = coalesceErrorRows(pairs);
    expect(out.map((r) => [r.span.spanId, r.repeat])).toEqual([["t0", 8], ["p0", 8]]);

    // A trailing partial repeat and a different tail survive uncollapsed.
    const ragged = coalesceErrorRows([...pairs.slice(0, 4), row("t9", "shell:powershell.exe"), row("x", "other", "different")]);
    expect(ragged.map((r) => [r.span.spanId, r.repeat ?? 1])).toEqual([["t0", 2], ["p0", 2], ["t9", 1], ["x", 1]]);

    // Period 1 still wins over period 2 for plain runs: A A A A collapses to one ×4 row, not two ×2 pairs.
    const run4 = coalesceErrorRows([row("a1", "retry"), row("a2", "retry"), row("a3", "retry"), row("a4", "retry")]);
    expect(run4.map((r) => [r.span.spanId, r.repeat])).toEqual([["a1", 4]]);
  });

  it("never folds different failing commands and accepts payload-less failed policy rows (#341 UAT)", () => {
    const cmd = (id: string, argument0: string): VisibleRow => ({
      span: span(id, { name: "shell:powershell.exe", depth: 2, attributes: { argument0 }, error: { type: "E", message: "exit code 1" } }),
      hasChildren: false, expanded: false, context: false,
    });
    // git/npm/node all fail with the same message — same name, different argument0: no ×N fold.
    const distinct = coalesceErrorRows([cmd("g", "git"), cmd("n", "npm"), cmd("d", "node")]);
    expect(distinct.map((r) => [r.span.spanId, r.repeat ?? 1])).toEqual([["g", 1], ["n", 1], ["d", 1]]);

    // A policy span with status error but no error payload still participates in a pair fold.
    const policy = (id: string): VisibleRow => ({
      span: span(id, { name: "policy.denied", depth: 2, status: "error" }),
      hasChildren: false, expanded: false, context: false,
    });
    const pairs = [cmd("t0", "npm"), policy("p0"), cmd("t1", "npm"), policy("p1")];
    expect(coalesceErrorRows(pairs).map((r) => [r.span.spanId, r.repeat])).toEqual([["t0", 2], ["p0", 2]]);
  });

  it("renders incomplete spans to the timeline end and zero-duration spans as instants", () => {
    const incomplete = span("open", { startedAt: at(400), durationMs: 100, incomplete: true });
    expect(barGeometry(incomplete, view)).toMatchObject({ left: 40, width: 60, openEnded: true, instant: false });

    const instant = span("instant", { startedAt: at(250), durationMs: 0 });
    expect(barGeometry(instant, view)).toMatchObject({ left: 25, width: 0, openEnded: false, instant: true });
  });
});
