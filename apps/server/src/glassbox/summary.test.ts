import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { ObservationEmitter } from "./emitter.js";
import { buildTrace } from "./query.js";
import { SCHEMA_VERSION, type EventInput, type ObservationEvent } from "./schema.js";
import { MemoryTraceStore, NdjsonTraceStore } from "./store.js";
import pg from "pg";
import { PostgresRunSummaryStore } from "./postgres-summary.js";
import { backfillSummaries, JsonRunSummaryStore, ROLLUP_VERSION, rollupRun, scheduleRollup, summaryFromView, type RunSummary, type RunSummaryStore } from "./summary.js";

let seq = 0;
const t = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
const ev = (over: Partial<ObservationEvent> & Pick<ObservationEvent, "type" | "category" | "spanId">): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + ++seq, sequence: seq, traceId: "trc_1", runId: "run-1", agentId: "agt-1",
  actorId: "local-user", actorType: "human", attempt: 1, timestamp: t(seq * 10), phase: "instant", status: "unset",
  name: over.type, source: { component: "test", observed: true }, attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});
const fixture = (): ObservationEvent[] => {
  seq = 0;
  return [
    ev({ type: "http.request.received", category: "control", spanId: "root", phase: "start", status: "running" }),
    ev({ type: "run.created", category: "control", spanId: "created", parentSpanId: "root", attributes: { configHash: "cfg-1", workspace: "ws" } }),
    ev({ type: "agent_service.run.started", category: "control", spanId: "svc", parentSpanId: "root", phase: "start", status: "running" }),
    ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", parentSpanId: "svc", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } }),
    ev({ type: "tool.call.started", category: "tool", spanId: "tool", parentSpanId: "rt", phase: "start", status: "running", actorType: "agent", actorId: "agt-1", attributes: { program: "ls" } }),
    ev({ type: "tool.call.failed", category: "tool", spanId: "tool", parentSpanId: "rt", phase: "end", status: "error", actorType: "agent", actorId: "agt-1", error: { type: "exit_code", message: "exit code 127" } }),
    ev({ type: "policy.denied", category: "policy", spanId: "deny", parentSpanId: "rt", status: "error", actorType: "service", actorId: "sandbox", attributes: { program: "curl" } }),
    ev({ type: "model.completed", category: "model", spanId: "m1", parentSpanId: "rt", status: "ok", privacy: { redacted: true, rulesetVersion: "1" }, attributes: { inputTokens: 10, outputTokens: 5 } }),
    ev({ type: "workspace.changed", category: "workspace", spanId: "ws", parentSpanId: "svc", status: "ok", source: { component: "AgentService", adapter: "WorkspaceSnapshot", observed: true }, attributes: { added: 1, modified: 2, removed: 0, bytesDelta: 12, truncated: false } }),
    ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", parentSpanId: "svc", phase: "end", status: "ok", source: { component: "AgentRunner", observed: true } }),
    ev({ type: "run.failed", category: "control", spanId: "failed", parentSpanId: "svc", status: "error" }),
    ev({ type: "agent_service.run.failed", category: "control", spanId: "svc", parentSpanId: "root", phase: "end", status: "error" }),
  ];
};

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function tempStore(): Promise<{ root: string; json: JsonStore; summaries: JsonRunSummaryStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-summary-test-"));
  dirs.push(root);
  const json = new JsonStore(path.join(root, "db.json"));
  await json.initialize();
  return { root, json, summaries: new JsonRunSummaryStore(json) };
}
const stub = (over: Partial<RunSummary>): RunSummary => ({
  ...summaryFromView(buildTrace([], { capturePolicy: "metadata_only" })), runId: "r", traceId: "t", agentId: "a", executionStatus: "completed", eventCount: 1, ...over,
});

describe("summaryFromView", () => {
  it("is buildTrace().summary field for field, plus the outcome fields", () => {
    const view = buildTrace(fixture(), { capturePolicy: "safe_summary", truncated: true });
    const s = view.summary;
    const summary = summaryFromView(view, { updatedAt: t(0) });
    expect(summary).toEqual({
      runId: s.runId, traceId: s.traceId, agentId: s.agentId, configHash: "cfg-1", capturePolicy: "safe_summary",
      executionStatus: "failed", taskOutcome: "unknown", taskOutcomeSource: undefined,
      startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs, lastEventAt: view.events.at(-1)?.timestamp,
      workspace: "ws", sessionId: undefined,
      metrics: s.metrics, usage: s.usage, denials: 1, actions: s.audit.actions, capabilities: s.capabilities, workspaceChanges: s.workspaceChanges,
      degraded: false, truncated: true, evicted: false, redactedEvents: 1, eventCount: 12,
      firstFailingStep: s.firstFailingStep, endedReason: undefined, interruptedAfterMs: undefined, rollupVersion: ROLLUP_VERSION, updatedAt: t(0),
    });
    expect(summary.metrics).toMatchObject({ terminalStatus: "error", toolCalls: 1, toolFailures: 1, modelCalls: 1, denials: 1, tokens: { input: 10, output: 5 } });
    expect(summary.actions).toBeGreaterThan(0);
  });
  it("carries the #132 outcome line from the terminal event into the stored summary", () => {
    seq = 0;
    const events = [ev({ type: "run.started", category: "control", spanId: "s", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "e", status: "ok", attributes: { finalMessageBytes: 9, reportedFailure: true }, summary: { text: "Unable to", policy: "safe_summary" } })];
    expect(summaryFromView(buildTrace(events, { capturePolicy: "safe_summary" })).outcome).toEqual({ text: "Unable to", finalMessageBytes: 9, reportedFailure: true });
  });
  it("maps every trace status onto an execution status; a restart-cancel keeps its reason", () => {
    const statuses = { ok: "completed", error: "failed", timeout: "timeout", cancelled: "cancelled" } as const;
    for (const [type, status] of Object.entries({ "run.completed": "ok", "run.failed": "error", "run.timed_out": "timeout", "run.cancelled": "cancelled" } as const)) {
      seq = 0;
      const events = [ev({ type: "run.started", category: "control", spanId: "s", status: "ok" }), ev({ type, category: "control", spanId: "e", status })];
      expect(summaryFromView(buildTrace(events, { capturePolicy: "metadata_only" })).executionStatus).toBe(statuses[status]);
    }
    seq = 0;
    const restart = [ev({ type: "run.started", category: "control", spanId: "s", status: "ok" }),
      ev({ type: "run.cancelled", category: "control", spanId: "c", status: "cancelled", actorType: "service", actorId: "server", attributes: { reason: "server_restart" } })];
    expect(summaryFromView(buildTrace(restart, { capturePolicy: "metadata_only" }))).toMatchObject({ executionStatus: "cancelled", endedReason: "server_restart", interruptedAfterMs: 0 });
    expect(summaryFromView(buildTrace([], { capturePolicy: "metadata_only" }))).toMatchObject({ executionStatus: "running", eventCount: 0 });
  });
});

// The store cases run against every backend (#191): Postgres only when DATABASE_URL points at a database.
const DATABASE_URL = process.env.DATABASE_URL;
interface Backend { name: string; open: () => Promise<{ summaries: RunSummaryStore; reopen: () => Promise<RunSummaryStore>; done: () => Promise<void> }> }
const backends: Backend[] = [
  { name: "JsonRunSummaryStore", open: async () => {
    const { root, summaries } = await tempStore();
    // reopening proves it survives a reload; an older db.json without the collection still loads
    const reopen = async () => { const r = new JsonStore(path.join(root, "db.json")); await r.initialize(); return new JsonRunSummaryStore(r); };
    return { summaries, reopen, done: async () => {} };
  } },
  ...(DATABASE_URL ? [{ name: "PostgresRunSummaryStore", open: async () => {
    const summaries = new PostgresRunSummaryStore(DATABASE_URL);
    await summaries.migrate();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query("DELETE FROM runs_summary");
    await pool.end();
    return { summaries, reopen: async () => new PostgresRunSummaryStore(DATABASE_URL), done: () => summaries.close() };
  } }] : []),
];

describe.each(backends)("$name", ({ open }) => {
  it("upserts, filters and returns newest first; setTaskOutcome records the source", async () => {
    const { summaries, reopen, done } = await open();
    await summaries.upsert(stub({ runId: "r1", agentId: "a", configHash: "c1", startedAt: t(100), executionStatus: "completed" }));
    await summaries.upsert(stub({ runId: "r2", agentId: "b", configHash: "c1", startedAt: t(300), executionStatus: "failed" }));
    await summaries.upsert(stub({ runId: "r3", agentId: "a", configHash: "c2", startedAt: t(200), executionStatus: "completed" }));
    await summaries.upsert(stub({ runId: "r1", agentId: "a", configHash: "c1", startedAt: t(100), executionStatus: "timeout" }));
    expect(await summaries.query()).toHaveLength(3);
    expect((await summaries.query()).map((s) => s.runId)).toEqual(["r2", "r3", "r1"]);
    expect((await summaries.query({ agentId: "a" })).map((s) => s.runId)).toEqual(["r3", "r1"]);
    expect((await summaries.query({ configHash: "c1" })).map((s) => s.runId)).toEqual(["r2", "r1"]);
    expect((await summaries.query({ executionStatus: "timeout" })).map((s) => s.runId)).toEqual(["r1"]);
    expect((await summaries.query({ from: t(150), to: t(250) })).map((s) => s.runId)).toEqual(["r3"]);
    expect((await summaries.query({ limit: 1 })).map((s) => s.runId)).toEqual(["r2"]);
    expect(await summaries.query({ taskOutcome: "passed" })).toEqual([]);
    await summaries.setTaskOutcome("r3", "passed", "deterministic:eval-1");
    // a rollup racing the evaluator cannot undo its verdict: upsert never touches the outcome fields
    expect(await summaries.upsert(stub({ runId: "r3", agentId: "a", configHash: "c2", startedAt: t(200), executionStatus: "failed" }))).toMatchObject({ executionStatus: "failed", taskOutcome: "passed", taskOutcomeSource: "deterministic:eval-1" });
    expect(await summaries.get("r3")).toMatchObject({ taskOutcome: "passed", taskOutcomeSource: "deterministic:eval-1" });
    expect((await summaries.query({ taskOutcome: "passed" })).map((s) => s.runId)).toEqual(["r3"]);
    await expect(summaries.setTaskOutcome("nope", "failed", "x")).rejects.toThrow("Run summary not found");
    expect(await summaries.get("missing")).toBeUndefined();
    const again = await reopen();
    expect((await again.get("r3"))?.taskOutcome).toBe("passed");
    expect((await again.get("r3"))?.metrics).toEqual((await summaries.get("r3"))?.metrics);
    await done();
  });
});

describe("rollup and backfill", () => {
  const emitAll = (emitter: ObservationEmitter, events: ObservationEvent[]) => {
    for (const e of events) {
      const { schemaVersion: _v, eventId: _id, sequence: _s, privacy: _p, ...input } = e;
      emitter.emit(input as EventInput);
    }
  };
  it("backfills every finished trace once, skips running Runs, and keeps an outcome across a re-rollup", async () => {
    const { root, summaries } = await tempStore();
    const traces = new NdjsonTraceStore(path.join(root, "traces"));
    await traces.initialize();
    const emitter = new ObservationEmitter({ store: traces, capturePolicy: "metadata_only" });
    emitAll(emitter, fixture());
    emitAll(emitter, fixture().map((e) => ({ ...e, runId: "run-2", traceId: "trc_2" })));
    emitAll(emitter, fixture().slice(0, 4).map((e) => ({ ...e, runId: "run-3", traceId: "trc_3" })));
    await emitter.flush();
    const deps = { traces, emitter, summaries };
    expect(await backfillSummaries(deps)).toEqual({ scanned: 3, written: 2, skipped: 1 });
    expect(await summaries.get("run-1")).toMatchObject({ executionStatus: "failed", taskOutcome: "unknown", eventCount: 12, rollupVersion: ROLLUP_VERSION });
    expect(await summaries.get("run-3")).toBeUndefined();
    // idempotent
    expect(await backfillSummaries(deps)).toEqual({ scanned: 3, written: 0, skipped: 3 });
    // stale version is rewritten; the outcome written by the evaluation plane survives
    await summaries.setTaskOutcome("run-2", "passed", "evaluator:e@1");
    await summaries.upsert({ ...(await summaries.get("run-2"))!, rollupVersion: 0 });
    expect(await backfillSummaries(deps)).toEqual({ scanned: 3, written: 1, skipped: 2 });
    expect(await summaries.get("run-2")).toMatchObject({ rollupVersion: ROLLUP_VERSION, taskOutcome: "passed", taskOutcomeSource: "evaluator:e@1" });
    // the summary and a fresh buildTrace never disagree
    const view = buildTrace(await traces.readRun("run-1"), { capturePolicy: "metadata_only" });
    const { updatedAt: _u, ...stored } = (await summaries.get("run-1"))!;
    const { updatedAt: _u2, ...derived } = summaryFromView(view);
    expect(stored).toEqual(derived);
  });
  it("scheduleRollup waits for the terminal event, swallows store failures and returns nothing for an unknown Run", async () => {
    const { summaries } = await tempStore();
    const traces = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store: traces, capturePolicy: "metadata_only" });
    emitAll(emitter, fixture());
    const logs: string[] = [];
    await scheduleRollup({ traces, emitter, summaries, log: (m) => logs.push(m) }, "run-1");
    expect((await summaries.get("run-1"))?.executionStatus).toBe("failed");
    expect(await rollupRun({ traces, emitter, summaries }, "missing")).toBeUndefined();
    const broken = { ...summaries, get: () => undefined, upsert: async () => { throw new Error("disk full"); } };
    await expect(scheduleRollup({ traces, emitter, summaries: broken, log: (m) => logs.push(m) }, "run-1")).resolves.toBeUndefined();
    expect(logs).toEqual(["summary.rollup_failed"]);
  });
  it("persists the configured cost estimate in the terminal Run rollup", async () => {
    const { summaries } = await tempStore();
    const traces = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store: traces, capturePolicy: "metadata_only" });
    emitAll(emitter, fixture().map((event) => event.type === "model.completed"
      ? { ...event, attributes: { ...event.attributes, cachedInputTokens: 4 } }
      : event));
    await emitter.flush();
    await rollupRun({ traces, emitter, summaries, pricing: { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 } }, "run-1");
    expect((await summaries.get("run-1"))?.estimatedCostUsd).toBe(0.000036);
  });
});
