import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import type { EvaluationStore } from "./glassbox/evaluation.js";
import { MemoryTraceStore } from "./glassbox/store.js";
import { RunLogStore } from "./run-log-store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

// Every route assertion runs in both modes: production registers the static web handler after the routes,
// which is exactly where #60 hid a 500. The token is ≥24 chars because production on 0.0.0.0 demands it.
const TOKEN = "uat-token-that-is-long-enough-xx";
const auth = { authorization: "Bearer " + TOKEN };

describe.each([["test"], ["production"]] as const)("HTTP boundary (NODE_ENV=%s)", (NODE_ENV) => {
  const config = (extra: Record<string, string> = {}) => loadConfig({ NODE_ENV, APP_AUTH_TOKEN: TOKEN, ...extra });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(config(), service);
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({ method: "GET", url: "/api/agents", headers: auth });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(config(), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("ends the root http span with the response status", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const calls: unknown[] = [];
    const svc = {
      ...service,
      sendMessage: async (
        id: string,
        _c: string,
        ctx?: {
          runId?: string;
          agentId?: string;
          traceId: string;
          rootSpanId: string;
          requestId?: string;
        },
      ) => {
        calls.push(ctx);
        if (ctx) {
          ctx.runId = "run-1";
          ctx.agentId = id;
          emitter.emit({
            traceId: ctx.traceId,
            spanId: ctx.rootSpanId,
            runId: "run-1",
            agentId: id,
            type: "http.request.received",
            category: "control",
            name: "POST /api/agents/:id/messages",
            phase: "start",
            status: "running",
            source: { component: "Fastify", observed: true },
            requestId: ctx.requestId,
          });
        }
        return { run: { id: "run-1" }, message: {} };
      },
    } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages",
      headers: auth,
      payload: { content: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(calls[0]).toBeTruthy();
    await emitter.flush();
    const events = await store.readRun("run-1");
    expect(events.map((e) => e.type)).toEqual(["http.request.received", "http.request.completed"]);
    expect(events[1]).toMatchObject({
      phase: "end",
      status: "ok",
      attributes: { statusCode: 202, method: "POST" },
    });
    expect(JSON.stringify(events)).not.toContain("authorization");
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    await app.close();
  });

  it("writes no trace events when the message POST is rejected", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const svc = {
      ...service,
      sendMessage: async () => {
        throw new HttpError(409, "This Agent is already running");
      },
    } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages",
      headers: auth,
      payload: { content: "hi" },
    });
    expect(res.statusCode).toBe(409);
    await emitter.flush();
    expect(store.listRuns()).toEqual([]);
    await app.close();
  });

  it("serves one Run's log lines under auth, bounded, with truncation reported (#75)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-logs-"));
    const logs = new RunLogStore(dir, 1_000_000);
    await logs.initialize();
    const line = (runId: string, n: number) => ({ time: new Date(n).toISOString(), level: n % 2 ? "error" : "info", msg: "line " + n, runId, traceId: "trc_" + runId, agentId: "agt-9" });
    for (let n = 0; n < 4; n++) await logs.append(line("run-9", n));
    await logs.append(line("run-8", 9));
    const svc = { ...service, getRun: (id: string) => { if (id !== "run-9") throw new HttpError(404, "Run not found"); return { id }; } } as unknown as AgentService;
    const store = new MemoryTraceStore();
    const app = await createApp(config(), svc, { emitter: new ObservationEmitter({ store, capturePolicy: "metadata_only" }), store, logs });
    expect((await app.inject({ method: "GET", url: "/api/runs/run-9/logs" })).statusCode).toBe(401);
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const all = (await get("/api/runs/run-9/logs")).json();
    expect(all).toEqual({ lines: [0, 1, 2, 3].map((n) => ({ time: new Date(n).toISOString(), level: n % 2 ? "error" : "info", msg: "line " + n })), truncated: false });
    const bounded = (await get("/api/runs/run-9/logs?level=error&limit=1")).json();
    expect(bounded).toEqual({ lines: [{ time: new Date(3).toISOString(), level: "error", msg: "line 3" }], truncated: true });
    expect((await get("/api/runs/run-9/logs?limit=9999")).statusCode).toBe(400);
    expect((await get("/api/runs/nope/logs")).statusCode).toBe(404);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists runs and serves a trace with schemaVersion and capturePolicy", async () => {
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const ids = { traceId: "trc_9", runId: "run-9", agentId: "agt-9" };
    const configSnapshot = { instructions: "sha256:" + "a".repeat(64), modelProvider: "ark", model: "model", codexSandboxMode: "workspace-write", runtimeProvider: "container", containerRuntimeImage: "runtime:test", capturePolicy: "metadata_only" } as const;
    emitter.emit({ ...ids, spanId: "root", type: "http.request.received", category: "control", name: "POST", phase: "start", status: "running", source: { component: "Fastify", observed: true } });
    emitter.emit({ ...ids, spanId: "created", parentSpanId: "root", type: "run.created", category: "control", name: "run.created", status: "ok", attributes: { configHash: "0123456789abcdef" }, source: { component: "AgentService", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", parentSpanId: "root", type: "runtime.codex.started", category: "runtime", name: "codex", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "tool", parentSpanId: "rt", type: "tool.call.failed", category: "tool", name: "shell", status: "error", source: { component: "CodexStreamObserver", observed: true } });
    emitter.emit({ ...ids, spanId: "model", parentSpanId: "rt", type: "model.completed", category: "model", name: "model", status: "ok", attributes: { outputTokens: 7 }, source: { component: "CodexStreamObserver", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", type: "runtime.codex.failed", category: "runtime", name: "codex", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "t", parentSpanId: "root", type: "run.timed_out", category: "control", name: "run.timed_out", status: "timeout", source: { component: "AgentService", observed: true } });
    await emitter.flush();
    const svc = { ...service, getRuns: () => [], listAgents: () => [{ id: "agt-9", name: "Nine" }],
      getRun: (id: string) => { if (id !== "run-9") throw new HttpError(404, "Run not found"); return { id, agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z", configHash: "0123456789abcdef", configSnapshot }; },
      allRuns: () => [{ id: "run-9", agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z", configHash: "0123456789abcdef", configSnapshot }] } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const list = await get("/api/runs?limit=10");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.schemaVersion).toBe("1.0"); expect(body.capturePolicy).toBe("metadata_only");
    expect(body.runs[0]).toMatchObject({ runId: "run-9", agentName: "Nine", status: "timeout", firstFailingStep: "codex", eventCount: 7, toolCalls: 1, toolFailures: 1, tokens: { output: 7 }, denials: 0, configHash: "0123456789abcdef", configSnapshot, capabilities: { model: "observed", tool: "observed" }, actions: 5 });
    const trace = await get("/api/runs/run-9/trace");
    expect(body.runs[0].toolCalls).toBe(trace.json().summary.metrics.toolCalls);
    expect(body.runs[0].toolFailures).toBe(trace.json().summary.metrics.toolFailures);
    expect(body.runs[0].tokens.output).toBe(trace.json().summary.metrics.tokens.output);
    expect(trace.json().summary.configHash).toBe(body.runs[0].configHash);
    expect(trace.json().summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", path: ["root", "rt"] });
    expect(trace.json().spans[0].children.some((span: { spanId: string }) => span.spanId === "rt")).toBe(true);
    expect((await get("/api/traces/trc_9")).json().summary.runId).toBe("run-9");
    const filtered = (await get("/api/traces/trc_9/events?status=timeout")).json();
    expect(filtered.events.map((e: { type: string }) => e.type)).toEqual(["runtime.codex.failed", "run.timed_out"]);
    const byCategories = (await get("/api/traces/trc_9/events?category=control,runtime")).json();
    expect(byCategories.events).toHaveLength(5);
    const audit = (await get("/api/runs/run-9/audit")).json();
    expect(audit.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "runtime.codex.failed", outcome: "timeout" })]));
    expect(audit.audit.every((row: { eventId: string }) => trace.json().events.some((event: { eventId: string }) => event.eventId === row.eventId))).toBe(true);
    expect((await get("/api/traces/trc_9/audit")).json().audit).toEqual(audit.audit);
    expect((await get("/api/runs/nope/trace")).statusCode).toBe(404);
    expect((await get("/api/runs?limit=9999")).statusCode).toBe(400);
    // FR-12: export = the trace route's body wrapped in { schemaVersion, exportedAt } — same builder, same policy.
    const exported = await get("/api/traces/trc_9/export");
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toMatch(/^application\/json/);
    expect(exported.headers["content-disposition"]).toBe('attachment; filename="trace-trc_9.json"');
    const { schemaVersion, exportedAt, ...view } = exported.json();
    expect(schemaVersion).toBe("1.0"); expect(Number.isNaN(Date.parse(exportedAt))).toBe(false);
    expect(JSON.stringify(view)).toBe(trace.body);
    expect((await get("/api/traces/nope/export")).json()).toEqual({ error: "Trace not found" });
    await app.close();
  });

  it("prefills a regression draft idempotently and persists only through the create route", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const runId = "12345678-1234-4234-8234-123456789abc";
    const agentId = "87654321-4321-4321-8321-cba987654321";
    emitter.emit({
      traceId: "trc-prefill", runId, agentId, spanId: "done", type: "run.completed", category: "control",
      name: "run.completed", status: "ok", source: { component: "AgentService", observed: true },
    });
    await emitter.flush();
    const persisted: unknown[] = [];
    const svc = {
      ...service,
      getRun: (id: string) => {
        expect(id).toBe(runId);
        return { id: runId, agentId, prompt: "check the fixture", configHash: "baseline-hash" };
      },
      getAgent: (id: string) => {
        expect(id).toBe(agentId);
        return { id: agentId, workspaceTemplate: "fixture" };
      },
      listRegressionCases: () => persisted,
      createRegressionCase: async (input: Record<string, unknown>) => {
        const created = { ...input, id: "case-1", createdAt: "2026-08-28T00:00:00.000Z" };
        persisted.push(created);
        return created;
      },
    } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const prefill = () => app.inject({ method: "GET", url: `/api/runs/${runId}/regression-case`, headers: auth });
    const first = await prefill();
    const second = await prefill();
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json()).toEqual({ draft: expect.objectContaining({
      name: "Case from Run 12345678 · fixture", sourceRunId: runId, workspaceTemplate: "fixture",
    }) });
    expect(persisted).toHaveLength(0);

    // The dialog posts only what it may change back to the Run route; the draft is re-derived server-side.
    const { name, assertions } = first.json().draft;
    const created = await app.inject({ method: "POST", url: `/api/runs/${runId}/regression-case`, headers: auth, payload: { name, assertions } });
    expect(created.statusCode).toBe(201);
    expect(created.json().regressionCase).toMatchObject({ id: "case-1", name, sourceRunId: runId, baselineConfigHash: "baseline-hash" });
    expect(persisted).toHaveLength(1);
    await app.close();
  });

  it("maps validation errors to 400 (static web build served in production)", async () => {
    // Regression (#60): `await app.register(fastifyStatic)` sat between the routes and setErrorHandler,
    // so the judged POC path answered every zod failure with Fastify's default 500.
    const app = await createApp(config(), service);
    const bad = await app.inject({ method: "POST", url: "/api/agents", headers: { ...auth, "content-type": "application/json" }, payload: "{}" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toHaveProperty("details");
    expect((await app.inject({ method: "GET", url: "/api/runs/not-a-uuid", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/nope", headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("lists evaluator definitions and current evaluations for an existing Run", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const runId = "019f3fa8-44d2-7b60-b413-1a0b2c3d4e5f";
    const definition = { id: "task_completion", name: "Task Completion", version: 1, type: "llm_judge" as const, rubric: "rubric", minScore: 1, maxScore: 5, passThreshold: 4, config: {}, setsTaskOutcome: true, createdAt: "2026-08-28T00:00:00.000Z" };
    const result = { runId, evaluatorId: definition.id, evaluatorVersion: 1, score: 5, passed: true, explanation: "completed", evidenceEventIds: ["evt-1"], metadata: {}, evaluatedAt: "2026-08-28T01:00:00.000Z" };
    const evaluations = {
      listDefinitions: async () => [definition],
      resultsForRun: async (id: string) => id === runId ? [result] : [],
    } as unknown as EvaluationStore;
    const svc = { ...service, getRun: (id: string) => { if (id !== runId) throw new HttpError(404, "Run not found"); return { id }; } } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store, evaluations });
    expect((await app.inject({ method: "GET", url: "/api/evaluators", headers: auth })).json()).toEqual({ evaluators: [definition] });
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/evaluations`, headers: auth })).json()).toEqual({ evaluations: [result] });
    expect((await app.inject({ method: "GET", url: "/api/runs/019f3fa8-44d2-7b60-b413-1a0b2c3d4e60/evaluations", headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("keeps the dialog's case name and retained assertions when deriving a regression case", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const ids = { runId: "019f3fa8-44d2-7b60-b413-1a0b2c3d4e5f", agentId: "019f3fa8-44d2-7b60-b413-1a0b2c3d4e60", traceId: "trc_case" };
    let saved: Record<string, unknown> | undefined;
    const svc = {
      ...service,
      getRun: () => ({ id: ids.runId, agentId: ids.agentId, status: "completed", prompt: "write a check", configHash: "baseline-hash" }),
      getAgent: () => ({ workspaceTemplate: "node-lib-with-failing-test" }),
      createRegressionCase: async (input: Record<string, unknown>) => {
        saved = input;
        return { ...input, id: "019f3fa8-44d2-7b60-b413-1a0b2c3d4e61", createdAt: "2026-08-26T00:00:00.000Z" };
      },
    } as unknown as AgentService;
    emitter.emit({ ...ids, spanId: "root", type: "run.created", category: "control", name: "run.created", phase: "start", status: "running", source: { component: "test", observed: true } });
    emitter.emit({ ...ids, spanId: "root", type: "run.completed", category: "control", name: "run.completed", phase: "end", status: "ok", source: { component: "test", observed: true } });
    await emitter.flush();
    const app = await createApp(config(), svc, { emitter, store });
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/" + ids.runId + "/regression-case",
      headers: { ...auth, "content-type": "application/json" },
      payload: { name: "Keeps only the terminal check", assertions: [{ type: "terminal_status", expected: "ok" }] },
    });
    expect(res.statusCode).toBe(201);
    expect(saved).toMatchObject({ name: "Keeps only the terminal check", sourceRunId: ids.runId, workspaceTemplate: "node-lib-with-failing-test", assertions: [{ type: "terminal_status", expected: "ok" }] });
    await app.close();
  });
});
