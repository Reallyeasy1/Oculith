import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
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
  const app = await createApp(loadConfig({ NODE_ENV: "test" }), svc, { emitter, store });
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages",
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
  await app.close();
});
