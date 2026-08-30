import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { LiveNotifier } from "./glassbox/live.js";
import { MemoryTraceStore } from "./glassbox/store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const TOKEN = "uat-token-that-is-long-enough-xx";

// index.ts wiring in miniature: emitter -> notifier -> SSE route.
function harness(heartbeatMs = 15_000) {
  const store = new MemoryTraceStore();
  const live = new LiveNotifier(heartbeatMs);
  const emitter = new ObservationEmitter({
    store,
    capturePolicy: "metadata_only",
    onEvent: (event) => live.publish({ type: "run.updated", runId: event.runId, agentId: event.agentId, status: event.status, ts: event.timestamp }),
  });
  return { glassbox: { emitter, store, live }, emitter, live };
}

function readUntil(stream: Readable, predicate: (buffer: string) => boolean, timeoutMs = 5_000): Promise<string> {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for SSE frame; received: " + JSON.stringify(buffer))), timeoutMs);
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      if (predicate(buffer)) {
        clearTimeout(timer);
        stream.destroy();
        resolve(buffer);
      }
    });
    stream.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

describe("GET /api/events/stream (#40)", () => {
  const config = (extra: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: TOKEN, ...extra });

  it("handshakes as an SSE response for a Bearer-authenticated client", async () => {
    const app = await createApp(config(), service, harness().glassbox);
    const response = await app.inject({ method: "GET", url: "/api/events/stream", headers: { authorization: "Bearer " + TOKEN }, payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toContain("no-cache");
    const preamble = await readUntil(response.stream(), (buffer) => buffer.includes("retry:"));
    expect(preamble).toContain("retry: 3000");
    await app.close();
  });

  it("enforces auth: no token 401, wrong ?access_token= 401, correct ?access_token= 200", async () => {
    const app = await createApp(config(), service, harness().glassbox);
    expect((await app.inject({ method: "GET", url: "/api/events/stream" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/events/stream?access_token=wrong" })).statusCode).toBe(401);
    const allowed = await app.inject({ method: "GET", url: "/api/events/stream?access_token=" + TOKEN, payloadAsStream: true });
    expect(allowed.statusCode).toBe(200);
    allowed.stream().destroy();
    await app.close();
  });

  it("does not let ?access_token= authenticate other API routes", async () => {
    const app = await createApp(config(), service, harness().glassbox);
    expect((await app.inject({ method: "GET", url: "/api/agents?access_token=" + TOKEN })).statusCode).toBe(401);
    await app.close();
  });

  it("delivers a run.updated frame when an observation event lands in the store", async () => {
    const { glassbox, emitter } = harness();
    const app = await createApp(config(), service, glassbox);
    const response = await app.inject({ method: "GET", url: "/api/events/stream?access_token=" + TOKEN, payloadAsStream: true });
    const framePromise = readUntil(response.stream(), (buffer) => buffer.includes("data:"));

    emitter.emit({ traceId: "trc_1", spanId: "spn_1", runId: "run-1", agentId: "agt-1", type: "run.created", category: "control", name: "run.created", status: "running", source: { component: "AgentService", observed: true } });
    await emitter.flush();

    const frame = await framePromise;
    const payload = JSON.parse(frame.split("data: ")[1]!.split("\n")[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: "run.updated", runId: "run-1", agentId: "agt-1", status: "running" });
    await app.close();
  });

  it("writes heartbeat comments on the configured interval", async () => {
    const app = await createApp(config(), service, harness(25).glassbox);
    const response = await app.inject({ method: "GET", url: "/api/events/stream?access_token=" + TOKEN, payloadAsStream: true });
    const frames = await readUntil(response.stream(), (buffer) => buffer.includes(":hb"));
    expect(frames).toContain(":hb");
    await app.close();
  });

  it("caps concurrent streams with a 503", async () => {
    const { glassbox } = harness();
    const app = await createApp(config(), service, glassbox);
    const streams = [];
    for (let i = 0; i < 4; i++) {
      const response = await app.inject({ method: "GET", url: "/api/events/stream?access_token=" + TOKEN, payloadAsStream: true });
      expect(response.statusCode).toBe(200);
      streams.push(response.stream());
    }
    const rejected = await app.inject({ method: "GET", url: "/api/events/stream?access_token=" + TOKEN });
    expect(rejected.statusCode).toBe(503);
    for (const stream of streams) stream.destroy();
    await app.close();
  });
});
