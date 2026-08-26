import { describe, expect, it } from "vitest";
import { buildTrace, flattenSpans, formatExitCode } from "./query.js";
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
  it("formats Windows crash and SIGKILL exit codes with deterministic operator hints", () => {
    expect(formatExitCode(3221225794)).toBe("3221225794 (0xC0000142) — process failed to initialise — the runtime CLI could not start; restart the server");
    expect(formatExitCode(137)).toBe("137 — SIGKILL (timeout, cancellation, or out-of-memory termination)");
    expect(formatExitCode(1)).toBe("1");
  });
  it("uses the formatted exit code in failure focus and diagnosis", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", status: "error", error: { type: "exit_code", message: "exit code 3221225794" } }),
      ev({ type: "run.failed", category: "control", spanId: "failed", parentSpanId: "svc", status: "error" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.failure?.message).toContain("3221225794 (0xC0000142)");
    expect(summary.failure?.diagnosis).toContain("runtime CLI could not start; restart the server");
  });
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
  it("interrupted by a server restart: focuses the deepest incomplete runtime span; clock stops at the last observed event", () => {
    seq = 0;
    const events = [root(), svcStart(),
      ev({ type: "runtime.container.started", category: "runtime", spanId: "ct", parentSpanId: "svc", phase: "start", status: "running", name: "docker run" }),
      ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", parentSpanId: "ct", phase: "start", status: "running", name: "codex exec", source: { component: "AgentRunner", observed: true } }),
      ev({ type: "run.cancelled", category: "control", spanId: "rc", parentSpanId: "svc", status: "cancelled", timestamp: t(60_000), source: { component: "AgentService", observed: true }, attributes: { reason: "server_restart" } })];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.status).toBe("cancelled");
    expect(view.summary.endedReason).toBe("server_restart");
    expect(view.summary.endedAt).toBe(t(60_000));
    expect(view.summary.durationMs).toBe(30); // codex exec start (t40) - root (t10), not the restart-cancel at t60000
    expect(view.summary.failure?.kind).toBe("cancelled");
    expect(view.summary.failure?.spanId).toBe("rt");
    expect(view.summary.failure?.eventId).toBe("evt_4");
    expect(view.summary.failure?.path).toEqual(["root", "svc", "ct", "rt"]);
    expect(view.summary.failure?.component).toBe("AgentRunner");
    expect(view.summary.firstFailingStep).toBe("codex exec");
    expect(view.summary.failure?.diagnosis).toBe("Run interrupted by a server restart after 0.0 s of observed activity; the runtime span codex exec never closed.");
  });
  it("user cancel (no reason): still focuses the cancelled codex exec span; no endedReason; full duration", () => {
    seq = 0;
    const events = [root(), svcStart(),
      ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", parentSpanId: "svc", phase: "start", status: "running", name: "codex exec" }),
      ev({ type: "runtime.codex.failed", category: "runtime", spanId: "rt", phase: "end", status: "cancelled", name: "codex exec", error: { type: "cancelled", message: "Run cancelled" } }),
      ev({ type: "run.cancelled", category: "control", spanId: "rc", parentSpanId: "svc", status: "cancelled" })];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.endedReason).toBeUndefined();
    expect(view.summary.durationMs).toBe(40);
    expect(view.summary.failure?.spanId).toBe("rt");
    expect(view.summary.firstFailingStep).toBe("codex exec");
    expect(view.summary.failure?.diagnosis).toContain("First actionable cancelled: codex exec");
  });
  it("handled tool failure then timeout: focuses the timeout span, not the earlier handled error", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "t", parentSpanId: "rt", status: "error", error: { type: "exit_code", message: "exit code 1" } }),
      ev({ type: "runtime.codex.failed", category: "runtime", spanId: "rt", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } }),
      ev({ type: "run.timed_out", category: "control", spanId: "rto", parentSpanId: "svc", status: "timeout" }),
      ev({ type: "agent_service.run.failed", category: "control", spanId: "svc", phase: "end", status: "timeout" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.status).toBe("timeout");
    expect(summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", name: "runtime.codex.failed" });
    expect(summary.firstFailingStep).toBe("runtime.codex.failed");
  });
  it("ok + degraded with a handled tool failure: kind degraded, no firstFailingStep", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "t", parentSpanId: "rt", status: "error", error: { type: "exit_code", message: "exit code 1" } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rd", parentSpanId: "svc", status: "ok" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only", degraded: true });
    expect(summary.status).toBe("ok");
    expect(summary.failure?.kind).toBe("degraded");
    expect(summary.firstFailingStep).toBeUndefined();
  });
  it("cut short before any stream event => capabilities unknown, never unavailable (invariant 3)", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "runtime.codex.failed", category: "runtime", spanId: "rt", phase: "end", status: "timeout", error: { type: "timeout", message: "Runtime timed out after 3000 ms" } }),
      ev({ type: "run.timed_out", category: "control", spanId: "rd", parentSpanId: "svc", status: "timeout" })];
    const v = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(v.summary.status).toBe("timeout");
    expect(v.summary.capabilities).toEqual({ model: "unknown", tool: "unknown" });
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
    expect(v.summary.failure).toMatchObject({ kind: "degraded", component: "GlassBox", path: [] });
    expect(v.summary.failure!.diagnosis).toMatch(/trace store was unavailable/i);
  });
  it("guards against a span-parent cycle: pathTo terminates and visits each id once", () => {
    seq = 0;
    const events = [
      root(),
      ev({ type: "tool.call.started", category: "tool", spanId: "x", parentSpanId: "y", phase: "start" }),
      ev({ type: "tool.call.started", category: "tool", spanId: "y", parentSpanId: "x", phase: "start" }),
      ev({ type: "tool.call.failed", category: "tool", spanId: "x", phase: "end", status: "error", error: { type: "exit", message: "boom" } }),
      ev({ type: "run.failed", category: "control", spanId: "rf", parentSpanId: "root" }),
    ];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.status).toBe("error");
    expect(summary.failure?.spanId).toBe("x");
    const path = summary.failure!.path;
    expect(new Set(path).size).toBe(path.length);
    expect(path).toEqual(expect.arrayContaining(["x", "y"]));
  });
  it("end-before-start: a later start event corrects the provisional span and closes it", () => {
    seq = 0;
    const events = [
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", phase: "start", status: "running" }),
    ];
    const { spans } = buildTrace(events, { capturePolicy: "metadata_only" });
    const rt = flattenSpans(spans).find((s) => s.spanId === "rt")!;
    expect(rt.incomplete).toBe(false);
    expect(rt.startedAt).toBe(events[1]!.timestamp);
    expect(rt.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("focuses an error.recorded event when it's the only failure candidate", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "error.recorded", category: "runtime", spanId: "rt", status: "error", error: { type: "panic", message: "unexpected null" } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.failed", category: "control", spanId: "rf", parentSpanId: "svc" }),
      ev({ type: "agent_service.run.failed", category: "control", spanId: "svc", phase: "end" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" })];
    const errEvent = events[3]!;
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.status).toBe("error");
    expect(summary.failure).toMatchObject({ kind: "error", eventId: errEvent.eventId });
    expect(summary.failure!.path.at(-1)).toBe("rt");
  });
  it("empty input yields an honest empty view", () => {
    const v = buildTrace([], { capturePolicy: "metadata_only" });
    expect(v.summary.status).toBe("unset"); expect(v.spans).toEqual([]); expect(v.summary.eventCount).toBe(0);
  });
});
