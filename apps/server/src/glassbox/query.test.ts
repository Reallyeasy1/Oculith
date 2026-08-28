import { describe, expect, it } from "vitest";
import { buildTrace, flattenSpans, formatExitCode, projectAudit } from "./query.js";
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
  it("projects safe text and metadata-only failure hints from the terminal Run event", () => {
    const completed = ev({
      type: "run.completed", category: "control", spanId: "done", status: "ok",
      attributes: { finalMessageBytes: 42, reportedFailure: true },
      summary: { text: "Unable to continue", policy: "safe_summary" },
    });
    expect(buildTrace([completed], { capturePolicy: "safe_summary" }).summary.outcome).toEqual({
      text: "Unable to continue", finalMessageBytes: 42, reportedFailure: true,
    });
    expect(buildTrace([{ ...completed, summary: undefined }], { capturePolicy: "metadata_only" }).summary.outcome).toEqual({
      finalMessageBytes: 42, reportedFailure: true,
    });
  });

  it("formats Windows crash and SIGKILL exit codes with deterministic operator hints", () => {
    expect(formatExitCode(3221225794)).toBe("3221225794 (0xC0000142) — process failed to initialise — the runtime CLI could not start; restart the server");
    expect(formatExitCode(137)).toBe("137 — SIGKILL (timeout, cancellation, or out-of-memory termination)");
    // the 128+N signal family a container runtime reports (observed 128 in UAT round 6)
    expect(formatExitCode(128)).toBe("128 — invalid exit argument, or the shell could not run the command");
    expect(formatExitCode(143)).toBe("143 — SIGTERM — asked to stop");
    expect(formatExitCode(1)).toBe("1");
    expect(formatExitCode(1)).toBe("1");
  });
  it("explains exit code 127 as a missing program", () => {
    expect(formatExitCode(127)).toBe("127 — command not found — the program is missing from the runtime image");
  });
  it("explains exit code 126 as found but not executable", () => {
    expect(formatExitCode(126)).toBe("126 — found but not executable — permissions or wrong interpreter");
  });
  it("explains exit code 124 as a timeout-wrapper kill", () => {
    expect(formatExitCode(124)).toBe("124 — timed out — killed by the timeout wrapper");
  });
  it("explains exit code 130 as SIGINT", () => {
    expect(formatExitCode(130)).toBe("130 — interrupted — SIGINT");
  });
  it("explains exit code 2 as a usage error or interpreter file-not-found", () => {
    expect(formatExitCode(2)).toBe("2 — usage error, or the interpreter could not find the file");
  });
  it("names the missing-program cause in the diagnosis for an exit code 127 tool failure", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", status: "error", name: "shell:curl", error: { type: "exit_code", message: "exit code 127" } }),
      ev({ type: "run.failed", category: "control", spanId: "failed", parentSpanId: "svc", status: "error" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.failure?.diagnosis).toContain("command not found");
  });
  it("formats exit-code hints on recovered spans without changing stored events", () => {
    seq = 0;
    const failedTool = ev({
      type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", status: "error",
      name: "shell:missing-command", error: { type: "exit_code", message: "exit code 127" },
    });
    const events = [root(), svcStart(), rtStart(), failedTool,
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "done", parentSpanId: "svc", status: "ok" })];

    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    const tool = flattenSpans(view.spans).find((span) => span.spanId === "tool");

    expect(view.summary.status).toBe("ok");
    expect(view.summary.failure).toBeUndefined();
    expect(tool?.error?.message).toBe("exit code 127 — command not found — the program is missing from the runtime image");
    expect(failedTool.error?.message).toBe("exit code 127");
    expect(view.events.find((event) => event.eventId === failedTool.eventId)?.error?.message).toBe("exit code 127");
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
  it("formats runner-shaped 'exited with code N: detail' messages without losing the detail", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "error.recorded", category: "control", spanId: "err", parentSpanId: "rt", status: "error", error: { type: "runtime_error", message: "Codex exited with code 137: stderr tail" } }),
      ev({ type: "run.failed", category: "control", spanId: "failed", parentSpanId: "svc", status: "error" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.failure?.message).toBe("Codex exited with code 137 — SIGKILL (timeout, cancellation, or out-of-memory termination): stderr tail");
  });
  it("prefers the platform workspace snapshot over the runtime stream's file_change report (#153)", () => {
    seq = 0;
    const report = ev({ type: "workspace.changed", category: "workspace", spanId: "wsr", parentSpanId: "rt", status: "ok",
      source: { component: "AgentRunner", adapter: "ContainerCodexRunner", observed: true }, attributes: { fileCount: 1, added: 0, updated: 1, deleted: 0 } });
    const snapshot = ev({ type: "workspace.changed", category: "workspace", spanId: "wss", parentSpanId: "svc", status: "ok",
      source: { component: "AgentService", adapter: "WorkspaceSnapshot", observed: true }, attributes: { added: 0, modified: 1, removed: 0, bytesDelta: 3, truncated: false, paths: "src/invoice.js" } });
    const done = [ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rdone", parentSpanId: "svc", status: "ok" })];
    // Stream report first (it arrives mid-Run), snapshot after the runtime closed — the snapshot must win.
    const both = buildTrace([root(), svcStart(), rtStart(), report, ...done.slice(0, 1), snapshot, done[1]!], { capturePolicy: "metadata_only" });
    expect(both.summary.workspaceChanges).toEqual({ added: 0, modified: 1, removed: 0, bytesDelta: 3, truncated: false });
    // Report alone (no snapshot ran): its vocabulary is normalised rather than read as zero.
    seq = 0;
    const only = buildTrace([root(), svcStart(), rtStart(), report, ...done], { capturePolicy: "metadata_only" });
    expect(only.summary.workspaceChanges).toMatchObject({ added: 0, modified: 1, removed: 0 });
  });
  it("reconstructs a nested tree with durations and rolls up ok", () => {
    seq = 0;
    const events = [
      root(), ev({ type: "run.created", category: "control", spanId: "rc", parentSpanId: "root", attributes: { workspace: "repo-doctor", configHash: "0123456789abcdef" } }), svcStart(), rtStart(),
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
    expect(view.summary.metrics).toEqual({
      durationMs: 70,
      terminalStatus: "ok",
      toolCalls: 1,
      toolFailures: 0,
      modelCalls: 1,
      timeToFirstToolMs: 30,
      timeSplit: { modelMs: 0, toolMs: 5, containerStartMs: 0 },
      tokens: { input: 10, output: 2 },
      retries: 0,
      denials: 0,
    });
    expect(view.summary.configHash).toBe("0123456789abcdef");
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
    expect(summary.metrics).toEqual({
      durationMs: 40,
      terminalStatus: "timeout",
      toolCalls: 0,
      toolFailures: 0,
      modelCalls: 0,
      timeSplit: { modelMs: 0, toolMs: 0, containerStartMs: 0 },
      retries: 0,
      denials: 0,
    });
  });
  it("computes retries, failed tool calls, denials and cached tokens from numeric evidence only", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool-retry", parentSpanId: "rt", status: "error", attempt: 2 }),
      ev({ type: "policy.denied", category: "policy", spanId: "denial", parentSpanId: "rt", status: "error" }),
      ev({ type: "model.completed", category: "model", spanId: "model", parentSpanId: "rt", status: "ok", attributes: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, text: "ignored" } }),
      ev({ type: "run.completed", category: "control", spanId: "done", parentSpanId: "svc", status: "ok" })];
    expect(buildTrace(events, { capturePolicy: "metadata_only" }).summary.metrics).toMatchObject({
      terminalStatus: "ok", toolCalls: 1, toolFailures: 1, modelCalls: 1,
      tokens: { input: 3, cachedInput: 2, output: 1 }, retries: 1, denials: 1,
    });
  });
  it("derives model/tool/container timing and time to first tool from observed spans", () => {
    seq = 0;
    const events = [
      root(),
      ev({ type: "run.created", category: "control", spanId: "created" }),
      ev({ type: "runtime.container.started", category: "infrastructure", spanId: "container", phase: "start", status: "running" }),
      ev({ type: "runtime.codex.started", category: "runtime", spanId: "codex", parentSpanId: "container", phase: "start", status: "running" }),
      ev({ type: "model.request", category: "model", spanId: "turn-1", parentSpanId: "codex", phase: "start", status: "running", name: "model.turn" }),
      ev({ type: "model.completed", category: "model", spanId: "turn-1", parentSpanId: "codex", phase: "end", status: "ok", name: "model.turn" }),
      ev({ type: "tool.call.started", category: "tool", spanId: "tool-1", parentSpanId: "codex", phase: "start", status: "running" }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool-1", parentSpanId: "codex", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "done", status: "ok" }),
    ];
    expect(buildTrace(events, { capturePolicy: "metadata_only" }).summary.metrics).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      timeToFirstToolMs: 50,
      timeSplit: { modelMs: 10, toolMs: 10, containerStartMs: 10 },
    });
  });
  it("prefers the observed per-call count over the single-turn span count for modelCalls (#207)", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "model.request", category: "model", spanId: "turn-1", parentSpanId: "rt", phase: "start", status: "running", name: "model.turn" }),
      ev({ type: "model.completed", category: "model", spanId: "turn-1", parentSpanId: "rt", phase: "end", status: "ok", name: "model.turn", attributes: { turnIndex: 1, modelCallsObserved: 4, inputTokens: 10 } }),
      // A second turn cut short before any item evidence still counts as at least one call.
      ev({ type: "model.request", category: "model", spanId: "turn-2", parentSpanId: "rt", phase: "start", status: "running", name: "model.turn" }),
      ev({ type: "run.cancelled", category: "control", spanId: "cancel", parentSpanId: "svc", status: "cancelled" }),
    ];
    expect(buildTrace(events, { capturePolicy: "metadata_only" }).summary.metrics.modelCalls).toBe(5);
  });
  it("subtracts tool time nested inside a model.turn so the time split does not double-count", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "model.request", category: "model", spanId: "turn-1", parentSpanId: "rt", phase: "start", status: "running", name: "model.turn" }),
      ev({ type: "tool.call.started", category: "tool", spanId: "tool-1", parentSpanId: "rt", phase: "start", status: "running" }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool-1", parentSpanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "model.completed", category: "model", spanId: "turn-1", parentSpanId: "rt", phase: "end", status: "ok", name: "model.turn" }),
      ev({ type: "run.completed", category: "control", spanId: "done", parentSpanId: "svc", status: "ok" }),
    ];
    // turn spans 30ms of wall clock; the tool inside it takes 10ms, so the model itself gets 20ms.
    expect(buildTrace(events, { capturePolicy: "metadata_only" }).summary.metrics.timeSplit).toEqual({ modelMs: 20, toolMs: 10, containerStartMs: 0 });
  });
  it("reconstructs paired tool durations and keeps only the first three bounded identities", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.started", category: "tool", spanId: "tool-1", parentSpanId: "rt", phase: "start", status: "running", name: "shell:python3", attributes: { program: "python3", argument0: "missing_script.py" } }),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool-1", parentSpanId: "rt", phase: "end", status: "error", name: "shell:python3", attributes: { program: "python3", argument0: "missing_script.py", exitCode: 2 } }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool-2", parentSpanId: "rt", status: "ok", attributes: { program: "npm", argument0: "test" } }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool-3", parentSpanId: "rt", status: "ok", attributes: { program: "git", argument0: "status" } }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool-4", parentSpanId: "rt", status: "ok", attributes: { program: "node", argument0: "check.js" } }),
      ev({ type: "run.completed", category: "control", spanId: "done", parentSpanId: "svc", status: "ok" }),
    ];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    const first = flattenSpans(view.spans).find((span) => span.spanId === "tool-1");
    expect(first).toMatchObject({ incomplete: false, durationMs: 10, attributes: { program: "python3", argument0: "missing_script.py" } });
    expect(view.summary.metrics.toolIdentities).toEqual(["python3 missing_script.py", "npm test", "git status"]);
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
      ev({ type: "run.cancelled", category: "control", spanId: "rc", parentSpanId: "svc", status: "cancelled", timestamp: t(60_000), source: { component: "AgentService", observed: true }, attributes: { reason: "server_restart", lastSeenAt: t(45_000) } })];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.status).toBe("cancelled");
    expect(view.summary.endedReason).toBe("server_restart");
    expect(view.summary.endedAt).toBe(t(60_000));
    expect(view.summary.durationMs).toBe(30); // codex exec start (t40) - root (t10), not the restart-cancel at t60000
    expect(view.summary.interruptedAfterMs).toBe(44_990); // last heartbeat (t45000) - root (t10): the boot at t60000 is not evidence the Run was alive
    expect(buildTrace(events.map((e) => (e.type === "run.cancelled" ? { ...e, attributes: { reason: "server_restart" } } : e)), { capturePolicy: "metadata_only" }).summary.interruptedAfterMs).toBe(30); // no heartbeat: falls back to last evidence
    expect(view.summary.failure?.kind).toBe("cancelled");
    expect(view.summary.failure?.spanId).toBe("rt");
    expect(view.summary.failure?.eventId).toBe("evt_4");
    expect(view.summary.failure?.path).toEqual(["root", "svc", "ct", "rt"]);
    expect(view.summary.failure?.component).toBe("AgentRunner");
    expect(view.summary.firstFailingStep).toBe("codex exec");
    expect(view.summary.failure?.diagnosis).toBe("Run interrupted by a server restart after 45.0 s; last trace evidence was 30 ms after the Run started; the runtime span codex exec never closed.");
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
  it("surfaces a handled sandbox denial even when the Run later completes", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", status: "error", name: "shell:pwsh", error: { type: "denied", message: "Command declined by the sandbox policy" } }),
      ev({ type: "policy.denied", category: "policy", spanId: "deny", parentSpanId: "rt", status: "error", name: "pwsh", source: { component: "Sandbox", observed: true }, attributes: { program: "pwsh", decision: "sandbox_declined", commandBytes: 9 } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "done", parentSpanId: "svc", status: "ok" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary).toMatchObject({ status: "ok", denials: 1, firstFailingStep: "pwsh" });
    expect(summary.failure).toMatchObject({ kind: "denied", name: "pwsh", component: "Sandbox", diagnosis: "sandbox declined `pwsh`" });
  });
  it("projects audit rows from stored facts and summarizes their counts", () => {
    seq = 0;
    const events = [root(),
      ev({ type: "run.created", category: "control", spanId: "created", name: "run.created" }),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool", name: "shell:git", actorType: "agent", actorId: "agt-1", status: "ok", attributes: { program: "git" } }),
      ev({ type: "policy.denied", category: "policy", spanId: "deny", name: "shell:pwsh", actorType: "service", actorId: "sandbox", status: "error", attributes: { program: "pwsh" } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok", name: "codex exec", actorType: "service", actorId: "runner" }),
      ev({ type: "run.completed", category: "control", spanId: "done", name: "run.completed", status: "ok" }),
    ];
    const rows = projectAudit(events);
    expect(rows.map((row) => row.eventId)).toEqual(expect.arrayContaining(events.map((event) => event.eventId)));
    expect(rows.find((row) => row.action === "run.created")).toMatchObject({ actor: { type: "human", id: "local-user" }, outcome: "allowed", resource: "run.created" });
    expect(rows.find((row) => row.action === "policy.denied")).toMatchObject({ actor: { type: "service", id: "sandbox" }, outcome: "denied", resource: "pwsh" });
    expect(rows.find((row) => row.action === "tool.call.completed")).toMatchObject({ actor: { type: "agent", id: "agt-1" }, outcome: "ok", resource: "git" });
    expect(rows.find((row) => row.action === "runtime.codex.completed")).toMatchObject({ actor: { type: "service", id: "runner" }, outcome: "ok" });
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.audit).toEqual({ actions: rows.length, denials: 1, actors: ["agent/agt-1", "human/local-user", "service/runner", "service/sandbox"] });
  });
  it("projects restart cancellation as a service audit fact", () => {
    seq = 0;
    const cancellation = ev({ type: "run.cancelled", category: "control", spanId: "cancel", status: "cancelled", actorType: "service", actorId: "server", attributes: { reason: "server_restart" } });
    expect(projectAudit([cancellation])).toEqual([expect.objectContaining({ action: "run.cancelled", outcome: "cancelled", actor: { type: "service", id: "server" } })]);
  });
  it("focuses a denial ahead of its associated tool failure when the Run fails", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", status: "error", name: "shell:node", error: { type: "denied", message: "Command declined by the sandbox policy" } }),
      ev({ type: "policy.denied", category: "policy", spanId: "deny", parentSpanId: "rt", status: "error", name: "node", source: { component: "Sandbox", observed: true }, attributes: { program: "node", decision: "sandbox_declined", commandBytes: 12 } }),
      ev({ type: "run.failed", category: "control", spanId: "failed", parentSpanId: "svc", status: "error" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.denials).toBe(1);
    expect(summary.failure).toMatchObject({ kind: "denied", name: "node", diagnosis: "sandbox declined `node`" });
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
  it("projects capability unavailability independently for each layer", () => {
    seq = 0;
    const modelOnly = buildTrace([
      ev({ type: "model.completed", category: "model", spanId: "model", attributes: { inputTokens: 1 } }),
      ev({ type: "capability.unavailable", category: "runtime", spanId: "cap", attributes: { model: false, tool: true } }),
    ], { capturePolicy: "metadata_only" });
    expect(modelOnly.summary.capabilities).toEqual({ model: "observed", tool: "unavailable" });

    const toolOnly = buildTrace([
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool" }),
      ev({ type: "capability.unavailable", category: "runtime", spanId: "cap", attributes: { model: true, tool: false } }),
    ], { capturePolicy: "metadata_only" });
    expect(toolOnly.summary.capabilities).toEqual({ model: "unavailable", tool: "observed" });
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
