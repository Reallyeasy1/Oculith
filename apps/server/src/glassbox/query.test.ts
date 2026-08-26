import { describe, expect, it } from "vitest";
import { buildTrace, flattenSpans } from "./query.js";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";

let seq = 0;
const t = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
const ev = (over: Partial<ObservationEvent> & Pick<ObservationEvent, "type" | "category" | "spanId">): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + ++seq, sequence: seq, traceId: "trc_1", runId: "run-1", agentId: "agt-1",
  actorId: "local-user", actorType: "human", attempt: 1, timestamp: t(seq * 10), phase: "instant", status: "unset",
  name: over.type, source: { component: "test", observed: true }, attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});
const root = () => ev({ type: "http.request.received", category: "control", spanId: "root", phase: "start", status: "running" });
const svcStart = () => ev({ type: "agent_service.run.started", category: "control", spanId: "svc", parentSpanId: "root", phase: "start", status: "running" });
const rtStart = () => ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", parentSpanId: "svc", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });

describe("buildTrace", () => {
  it("reconstructs a nested tree with durations and rolls up ok", () => {
    seq = 0;
    const events = [
      root(), ev({ type: "run.created", category: "control", spanId: "rc", parentSpanId: "root" }), svcStart(), rtStart(),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool1", parentSpanId: "rt", status: "ok", durationMs: 5 }),
      ev({ type: "model.completed", category: "model", spanId: "m1", parentSpanId: "rt", status: "ok", attributes: { inputTokens: 10, outputTokens: 2 } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rdone", parentSpanId: "svc", status: "ok" }),
      ev({ type: "agent_service.run.completed", category: "control", spanId: "svc", phase: "end", status: "ok" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" }),
    ];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.status).toBe("ok");
    expect(view.summary.spanCount).toBe(7);
    expect(view.summary.incompleteSpans).toBe(0);
    expect(view.summary.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(view.summary.capabilities).toEqual({ model: "observed", tool: "observed" });
    expect(view.spans[0]!.spanId).toBe("root");
    const rt = flattenSpans(view.spans).find((s) => s.spanId === "rt")!;
    expect(rt.depth).toBe(2); expect(rt.durationMs).toBe(30); expect(rt.children.map((c) => c.spanId)).toEqual(["tool1", "m1"]);
    expect(view.summary.failure).toBeUndefined();
  });
  it("timeout: focuses the runtime span, not the later control failure", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "runtime.codex.failed", category: "runtime", spanId: "rt", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } }),
      ev({ type: "run.timed_out", category: "control", spanId: "rto", parentSpanId: "svc", status: "timeout" }),
      ev({ type: "agent_service.run.failed", category: "control", spanId: "svc", phase: "end", status: "timeout" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.status).toBe("timeout");
    expect(summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", component: "AgentRunner", path: ["root", "svc", "rt"] });
    expect(summary.failure!.diagnosis).toMatch(/^Run timeout in AgentRunner after 0\.\d+ s\. First actionable timeout: runtime\.codex\.failed/);
    expect(summary.firstFailingStep).toBe("runtime.codex.failed");
  });
  it("handled tool failure keeps parent ok; cancelled never rolls up ok; open spans are incomplete", () => {
    seq = 0;
    const handled = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "t", parentSpanId: "rt", status: "error", error: { type: "exit", message: "exit 1" } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rd", parentSpanId: "svc", status: "ok" }),
      ev({ type: "agent_service.run.completed", category: "control", spanId: "svc", phase: "end", status: "ok" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" })];
    const h = buildTrace(handled, { capturePolicy: "metadata_only" });
    expect(h.summary.status).toBe("ok");
    expect(h.summary.failure).toBeUndefined();
    seq = 0;
    const cancelled = [root(), svcStart(), rtStart(), ev({ type: "run.cancelled", category: "control", spanId: "rc", parentSpanId: "svc", status: "cancelled", attributes: { reason: "server_restart" } })];
    const c = buildTrace(cancelled, { capturePolicy: "metadata_only" });
    expect(c.summary.status).toBe("cancelled");
    expect(c.summary.incompleteSpans).toBe(3);
    expect(c.summary.failure?.kind).toBe("cancelled");
    expect(flattenSpans(c.spans).every((s) => s.spanId === "rc" || s.incomplete)).toBe(true);
  });
  it("no model/tool events => capabilities unavailable; degraded flag surfaces", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "capability.unavailable", category: "runtime", spanId: "cap", parentSpanId: "rt", attributes: { model: false, tool: false } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rd", parentSpanId: "svc", status: "ok" })];
    const v = buildTrace(events, { capturePolicy: "metadata_only", degraded: true });
    expect(v.summary.capabilities).toEqual({ model: "unavailable", tool: "unavailable" });
    expect(v.summary.degraded).toBe(true);
    expect(v.summary.status).toBe("ok");
  });
  it("empty input yields an honest empty view", () => {
    const v = buildTrace([], { capturePolicy: "metadata_only" });
    expect(v.summary.status).toBe("unset"); expect(v.spans).toEqual([]); expect(v.summary.eventCount).toBe(0);
  });
});
