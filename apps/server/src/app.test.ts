import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

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

  it("lists runs and serves a trace with schemaVersion and capturePolicy", async () => {
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const ids = { traceId: "trc_9", runId: "run-9", agentId: "agt-9" };
    emitter.emit({ ...ids, spanId: "root", type: "http.request.received", category: "control", name: "POST", phase: "start", status: "running", source: { component: "Fastify", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", parentSpanId: "root", type: "runtime.codex.started", category: "runtime", name: "codex", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", type: "runtime.codex.failed", category: "runtime", name: "codex", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "t", parentSpanId: "root", type: "run.timed_out", category: "control", name: "run.timed_out", status: "timeout", source: { component: "AgentService", observed: true } });
    await emitter.flush();
    const svc = { ...service, getRuns: () => [], listAgents: () => [{ id: "agt-9", name: "Nine" }],
      getRun: (id: string) => { if (id !== "run-9") throw new HttpError(404, "Run not found"); return { id, agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z" }; },
      allRuns: () => [{ id: "run-9", agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z" }] } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const list = await get("/api/runs?limit=10");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.schemaVersion).toBe("1.0"); expect(body.capturePolicy).toBe("metadata_only");
    expect(body.runs[0]).toMatchObject({ runId: "run-9", agentName: "Nine", status: "timeout", firstFailingStep: "codex", eventCount: 4, denials: 0 });
    const trace = await get("/api/runs/run-9/trace");
    expect(trace.json().summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", path: ["root", "rt"] });
    expect(trace.json().spans[0].children[0].spanId).toBe("rt");
    expect((await get("/api/traces/trc_9")).json().summary.runId).toBe("run-9");
    const filtered = (await get("/api/traces/trc_9/events?status=timeout")).json();
    expect(filtered.events.map((e: { type: string }) => e.type)).toEqual(["runtime.codex.failed", "run.timed_out"]);
    const byCategories = (await get("/api/traces/trc_9/events?category=control,runtime")).json();
    expect(byCategories.events).toHaveLength(4);
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
});
