// ponytail: one runnable check for the tree/filter logic. Web has no test script; run from repo root with
//   npx vitest run apps/web/src/trace-view-model.test.ts
// (vitest is hoisted from the server workspace — no new dependency.)
import { describe, expect, it } from "vitest";
import type { Span, TraceView } from "./types";
import { EMPTY_FILTER, barGeometry, defaultExpanded, matchesSpan, visibleRows } from "./trace-view-model";

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
    denials: 0, audit: { actions: 0, denials: 0, actors: [] }, truncated: false, evicted: false, capabilities: { model: "unavailable", tool: "unavailable" },
    failure: { kind: "error", spanId: "a1", eventId: "e", sequence: 3, name: "a1", category: "runtime", component: "test", path: ["root", "a", "a1"], diagnosis: "x" },
  },
  spans: [root],
  events: [],
};

describe("trace-view-model", () => {
  it("expands roots plus the failure path by default and omits collapsed subtrees from the rows", () => {
    const expanded = defaultExpanded(view);
    expect([...expanded].sort()).toEqual(["a", "a1", "root"]);
    const ids = visibleRows(view.spans, expanded, EMPTY_FILTER).map((r) => r.span.spanId);
    expect(ids).toEqual(["root", "a", "a1", "b"]); // b collapsed → b1/b2 not rendered
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
    expect(barGeometry(a1, view)).toEqual({ left: 50, width: 20 });
    expect(barGeometry(root, { ...view, summary: { ...view.summary, durationMs: undefined } })).toBeUndefined();
  });
});
