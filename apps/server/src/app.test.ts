import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { AgentService as RealAgentService, type AgentService } from "./agent-service.js";
import { WorkspaceManager } from "./workspace.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import type { EvaluationStore } from "./glassbox/evaluation.js";
import { JsonEvaluationStore } from "./glassbox/evaluation.js";
import { builtinRunEvaluators, EvaluationJobWorker, JsonEvaluationJobStore } from "./glassbox/jobs.js";
import { buildTrace } from "./glassbox/query.js";
import { MemoryTraceStore } from "./glassbox/store.js";
import { JsonRunSummaryStore, summaryFromView } from "./glassbox/summary.js";
import { JsonStore } from "./store.js";
import { RunLogStore } from "./run-log-store.js";
import type { RunSummary, RunSummaryStore } from "./glassbox/summary.js";

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
      // #54: a query string must not bypass the ingress hook (it used to regex-match request.url).
      url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages?client=vitest",
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

  it("serves budget status and validates budget input at the boundary (#255)", async () => {
    const svc = {
      ...service,
      budgetStatus: async () => ({
        budget: { maxTokensPerDay: 100 },
        usage: { totalTokens: 110, estimatedCostUsd: 0, runs: 1, windowStart: "2026-08-28T12:00:00.000Z" },
        denial: { decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: 100, used: 110 },
      }),
      createAgent: async (input: unknown) => input,
    } as unknown as AgentService;
    const app = await createApp(config(), svc);
    const status = await app.inject({ method: "GET", url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/budget", headers: auth });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      budget: { maxTokensPerDay: 100 }, exceeded: true,
      usage: { totalTokens: 110, runs: 1 }, denial: { decision: "budget_exceeded", limit: "maxTokensPerDay" },
    });

    const create = (budget: unknown) => app.inject({
      method: "POST", url: "/api/agents",
      headers: { ...auth, "content-type": "application/json" },
      payload: { name: "budgeted", budget },
    });
    expect((await create({ maxTokensPerDay: 10 })).statusCode).toBe(201);
    expect((await create(null)).statusCode).toBe(201);
    expect((await create({ maxTokensPerDay: 0 })).statusCode).toBe(400);
    expect((await create({ maxEstimatedUsdPerDay: -1 })).statusCode).toBe(400);
    expect((await create({ maxTokensPerDay: 1.5 })).statusCode).toBe(400);
    await app.close();
  });

  it("threads rerunOf through to sendMessage as a run.created tag, absent when omitted (#256)", async () => {
    const options: unknown[] = [];
    const svc = {
      ...service,
      sendMessage: async (_id: string, _content: string, _ctx: unknown, opts: unknown) => {
        options.push(opts);
        return { run: { id: "run-1" }, message: {} };
      },
    } as unknown as AgentService;
    const app = await createApp(config(), svc);
    const post = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages",
      headers: { ...auth, "content-type": "application/json" },
      payload,
    });
    const rerunOf = "12345678-1234-4234-8234-123456789abc";
    expect((await post({ content: "again", rerunOf })).statusCode).toBe(202);
    expect((await post({ content: "fresh" })).statusCode).toBe(202);
    expect((await post({ content: "bad", rerunOf: "not-a-uuid" })).statusCode).toBe(400);
    expect(options).toEqual([{ tags: { rerunOf } }, {}]);
    await app.close();
  });

  it("passes the queued receipt through as 202 and cancels a pending message (#254)", async () => {
    const agentId = "2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b";
    const messageId = "9e107d9d-3721-4a2f-8f3b-1a2b3c4d5e6f";
    const cancelled: string[][] = [];
    const svc = {
      ...service,
      sendMessage: async () => ({ queued: true, position: 2, messageId }),
      cancelPendingMessage: async (id: string, message: string) => { cancelled.push([id, message]); },
    } as unknown as AgentService;
    const app = await createApp(config(), svc);
    const posted = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { content: "hi" },
    });
    expect(posted.statusCode).toBe(202);
    expect(posted.json()).toEqual({ queued: true, position: 2, messageId });

    const removed = await app.inject({ method: "DELETE", url: `/api/agents/${agentId}/messages/${messageId}`, headers: auth });
    expect(removed.statusCode).toBe(204);
    expect(cancelled).toEqual([[agentId, messageId]]);
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${agentId}/messages/not-a-uuid`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${agentId}/messages/${messageId}` })).statusCode).toBe(401);
    await app.close();
  });

  it("serves one Run's log lines under auth, bounded, with truncation reported (#75)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-logs-"));
    const logs = new RunLogStore(dir, 1_000_000);
    await logs.initialize();
    const run9 = "019f3fa8-44d2-7b60-b413-1a0b2c3d4e09";
    const run8 = "019f3fa8-44d2-7b60-b413-1a0b2c3d4e08";
    const line = (runId: string, n: number) => ({ time: new Date(n).toISOString(), level: n % 2 ? "error" : "info", msg: "line " + n, runId, traceId: "trc_" + runId, agentId: "agt-9" });
    for (let n = 0; n < 4; n++) await logs.append(line(run9, n));
    await logs.append(line(run8, 9));
    const svc = { ...service, getRun: (id: string) => { if (id !== run9) throw new HttpError(404, "Run not found"); return { id }; } } as unknown as AgentService;
    const store = new MemoryTraceStore();
    const app = await createApp(config(), svc, { emitter: new ObservationEmitter({ store, capturePolicy: "metadata_only" }), store, logs });
    expect((await app.inject({ method: "GET", url: `/api/runs/${run9}/logs` })).statusCode).toBe(401);
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const all = (await get(`/api/runs/${run9}/logs`)).json();
    expect(all).toEqual({ lines: [0, 1, 2, 3].map((n) => ({ time: new Date(n).toISOString(), level: n % 2 ? "error" : "info", msg: "line " + n })), truncated: false });
    const bounded = (await get(`/api/runs/${run9}/logs?level=error&limit=1`)).json();
    expect(bounded).toEqual({ lines: [{ time: new Date(3).toISOString(), level: "error", msg: "line 3" }], truncated: true });
    expect((await get(`/api/runs/${run9}/logs?limit=9999`)).statusCode).toBe(400);
    expect((await get("/api/runs/019f3fa8-44d2-7b60-b413-1a0b2c3d4eff/logs")).statusCode).toBe(404);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the read-only workspace browser: auth, listing, file preview, 400/404 (#65)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-api-"));
    try {
      const cfg = config({
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });
      const runner = { run: async () => ({ output: "", threadId: "t" }), cancel: async () => false, isAvailable: async () => true };
      const svc = new RealAgentService(cfg, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner);
      await svc.initialize();
      const agent = await svc.createAgent({ name: "Browser" });
      await mkdir(path.join(agent.workspacePath, "src"));
      await writeFile(path.join(agent.workspacePath, "src", "index.ts"), "export {};\n", "utf8");
      await writeFile(path.join(agent.workspacePath, "blob.bin"), Buffer.from([1, 0, 2]));
      const app = await createApp(cfg, svc);
      const base = "/api/agents/" + agent.id;
      expect((await app.inject({ method: "GET", url: base + "/workspace" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: base + "/workspace/file?path=AGENTS.md" })).statusCode).toBe(401);
      const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

      const listing = (await get(base + "/workspace")).json();
      expect(listing.truncated).toBe(false);
      expect(listing.entries[0]).toMatchObject({ name: "src", kind: "dir" });
      expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(
        expect.arrayContaining(["AGENTS.md", "README.md", ".gitignore", "blob.bin"]),
      );
      const nested = (await get(base + "/workspace?path=src")).json();
      expect(nested).toMatchObject({ path: "src", truncated: false });
      expect(nested.entries).toEqual([{ name: "index.ts", kind: "file", size: 11, mtime: expect.any(String) }]);

      const instructions = (await get(base + "/workspace/file?path=AGENTS.md")).json();
      expect(instructions).toMatchObject({ path: "AGENTS.md", encoding: "utf8", managed: true });
      expect(instructions.content).toContain("Platform-managed Agent instructions");
      const binary = (await get(base + "/workspace/file?path=blob.bin")).json();
      expect(binary).toMatchObject({ path: "blob.bin", encoding: "binary", managed: false, size: 3 });
      expect(binary.content).toBeUndefined();

      expect((await get(base + "/workspace?path=" + encodeURIComponent("../"))).statusCode).toBe(400);
      expect((await get(base + "/workspace/file?path=" + encodeURIComponent("..\\..\\etc\\passwd"))).statusCode).toBe(400);
      expect((await get(base + "/workspace/file?path=" + encodeURIComponent("/etc/passwd"))).statusCode).toBe(400);
      expect((await get(base + "/workspace/file?path=src")).statusCode).toBe(400);
      expect((await get(base + "/workspace?path=missing")).statusCode).toBe(404);
      expect((await get(base + "/workspace/file?path=missing.txt")).statusCode).toBe(404);
      expect((await get("/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/workspace")).statusCode).toBe(404);
      expect((await get(base + "/workspace?path=" + encodeURIComponent("x".repeat(2_000)))).statusCode).toBe(400);
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves workspace editing: write, seed, delete, reset, history and refusals (#66)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-edit-api-"));
    try {
      const cfg = config({
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });
      const runner = { run: async () => ({ output: "", threadId: "t" }), cancel: async () => false, isAvailable: async () => true };
      const svc = new RealAgentService(cfg, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner);
      await svc.initialize();
      const agent = await svc.createAgent({ name: "Editable" });
      const app = await createApp(cfg, svc);
      const base = "/api/agents/" + agent.id;
      const call = (method: "PUT" | "POST" | "DELETE", url: string, payload?: unknown) =>
        app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });

      expect((await app.inject({ method: "PUT", url: base + "/workspace/file", payload: { path: "x", content: "" } })).statusCode).toBe(401);

      const written = await call("PUT", base + "/workspace/file", { path: "src/app.ts", content: "export {};\n" });
      expect(written.statusCode).toBe(200);
      expect(written.json()).toEqual({ file: { path: "src/app.ts", bytes: 11 } });
      expect(await readFile(path.join(agent.workspacePath, "src", "app.ts"), "utf8")).toBe("export {};\n");

      const seeded = await call("POST", base + "/workspace/files", {
        files: [
          { path: "data/a.json", content: "{}" },
          { path: "logo.bin", content: Buffer.from([9, 9]).toString("base64"), encoding: "base64" },
        ],
      });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json().files).toHaveLength(2);

      expect((await call("DELETE", base + "/workspace/file?path=" + encodeURIComponent("data/a.json"))).json())
        .toEqual({ file: { path: "data/a.json", bytes: 2 } });

      // Refusals carry the reason: managed file, credential-looking content, invalid body shapes.
      const managed = await call("PUT", base + "/workspace/file", { path: "AGENTS.md", content: "x" });
      expect(managed.statusCode).toBe(400);
      expect(managed.json().error).toContain("platform-managed");
      const leaky = await call("PUT", base + "/workspace/file", { path: ".env", content: "MY_API_KEY=abcdef012345" });
      expect(leaky.statusCode).toBe(400);
      expect(leaky.json().error).toContain("credential");
      expect((await call("PUT", base + "/workspace/file", { path: "", content: "x" })).statusCode).toBe(400);
      expect((await call("POST", base + "/workspace/files", { files: [] })).statusCode).toBe(400);
      expect((await call("POST", base + "/workspace/files", {
        files: Array.from({ length: 21 }, (_, i) => ({ path: "f" + i, content: "" })),
      })).statusCode).toBe(400);
      expect((await call("DELETE", base + "/workspace/file?path=")).statusCode).toBe(400);

      // History is on the Agent record, newest first; reset archives and can forget the thread.
      const history = (await app.inject({ method: "GET", url: base, headers: auth })).json().agent.workspaceHistory;
      expect(history.map((entry: { action: string; path: string }) => [entry.action, entry.path])).toEqual([
        ["delete", "data/a.json"],
        ["seed", "data/a.json"],
        ["seed", "logo.bin"],
        ["write", "src/app.ts"],
      ]);

      const reset = await call("POST", base + "/workspace/reset", { forgetThread: true });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().archivedWorkspace).toContain(".deleted");
      expect(reset.json().agent.codexThreadId).toBeNull();
      expect(reset.json().agent.workspaceHistory[0]).toMatchObject({ action: "reset", path: "" });
      await expect(readFile(path.join(agent.workspacePath, "src", "app.ts"), "utf8")).rejects.toThrowError();
      expect(await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8")).toContain("Editable");
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("trace events q also searches summary text, and an unknown traceId is 404 (#54)", async () => {
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const ids = { traceId: "trc_q", runId: "run-q", agentId: "agt-q" };
    emitter.emit({ ...ids, spanId: "a", type: "run.created", category: "control", name: "run.created", status: "ok", summary: { text: "deploy the pelican service", policy: "safe_summary" }, source: { component: "AgentService", observed: true } });
    emitter.emit({ ...ids, spanId: "b", type: "run.completed", category: "control", name: "run.completed", status: "ok", source: { component: "AgentService", observed: true } });
    await emitter.flush();
    const app = await createApp(config(), service, { emitter, store });
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const hit = (await get("/api/traces/trc_q/events?q=pelican")).json();
    expect(hit.events.map((e: { spanId: string }) => e.spanId)).toEqual(["a"]);
    expect((await get("/api/traces/trc_q/events?q=albatross")).json().events).toEqual([]);
    expect((await get("/api/traces/nope")).statusCode).toBe(404);
    await app.close();
  });

  it("lists runs and serves a trace with schemaVersion and capturePolicy", async () => {
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const run9 = "019f3fa8-44d2-7b60-b413-1a0b2c3d4e90";
    const ids = { traceId: "trc_9", runId: run9, agentId: "agt-9" };
    const configSnapshot = { instructions: "sha256:" + "a".repeat(64), modelProvider: "ark", model: "model", codexSandboxMode: "workspace-write", runtimeProvider: "container", containerRuntimeImage: "runtime:test", capturePolicy: "metadata_only" } as const;
    emitter.emit({ ...ids, spanId: "root", type: "http.request.received", category: "control", name: "POST", phase: "start", status: "running", source: { component: "Fastify", observed: true } });
    emitter.emit({ ...ids, sessionId: "thr-9", spanId: "created", parentSpanId: "root", type: "run.created", category: "control", name: "run.created", status: "ok", attributes: { configHash: "0123456789abcdef" }, source: { component: "AgentService", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", parentSpanId: "root", type: "runtime.codex.started", category: "runtime", name: "codex", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "tool", parentSpanId: "rt", type: "tool.call.failed", category: "tool", name: "shell", status: "error", source: { component: "CodexStreamObserver", observed: true } });
    emitter.emit({ ...ids, spanId: "model", parentSpanId: "rt", type: "model.completed", category: "model", name: "model", status: "ok", attributes: { outputTokens: 7 }, source: { component: "CodexStreamObserver", observed: true } });
    emitter.emit({ ...ids, spanId: "rt", type: "runtime.codex.failed", category: "runtime", name: "codex", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } });
    emitter.emit({ ...ids, spanId: "t", parentSpanId: "root", type: "run.timed_out", category: "control", name: "run.timed_out", status: "timeout", source: { component: "AgentService", observed: true } });
    await emitter.flush();
    const svc = { ...service, getRuns: () => [], listAgents: () => [{ id: "agt-9", name: "Nine" }],
      getRun: (id: string) => { if (id !== run9) throw new HttpError(404, "Run not found"); return { id, agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z", configHash: "0123456789abcdef", configSnapshot }; },
      allRuns: () => [{ id: run9, agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z", configHash: "0123456789abcdef", configSnapshot }] } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store });
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const list = await get("/api/runs?limit=10");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.schemaVersion).toBe("1.0"); expect(body.capturePolicy).toBe("metadata_only");
    expect(body.runs[0]).toMatchObject({ runId: run9, agentName: "Nine", sessionId: "thr-9", status: "timeout", firstFailingStep: "codex", eventCount: 7, toolCalls: 1, toolFailures: 1, tokens: { output: 7 }, denials: 0, configHash: "0123456789abcdef", configSnapshot, capabilities: { model: "observed", tool: "observed" }, actions: 5 });
    const trace = await get(`/api/runs/${run9}/trace`);
    expect(body.runs[0].toolCalls).toBe(trace.json().summary.metrics.toolCalls);
    expect(body.runs[0].toolFailures).toBe(trace.json().summary.metrics.toolFailures);
    expect(body.runs[0].tokens.output).toBe(trace.json().summary.metrics.tokens.output);
    expect(trace.json().summary.configHash).toBe(body.runs[0].configHash);
    expect(trace.json().summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", path: ["root", "rt"] });
    expect(trace.json().spans[0].children.some((span: { spanId: string }) => span.spanId === "rt")).toBe(true);
    expect((await get("/api/traces/trc_9")).json().summary.runId).toBe(run9);
    const filtered = (await get("/api/traces/trc_9/events?status=timeout")).json();
    expect(filtered.events.map((e: { type: string }) => e.type)).toEqual(["runtime.codex.failed", "run.timed_out"]);
    const byCategories = (await get("/api/traces/trc_9/events?category=control,runtime")).json();
    expect(byCategories.events).toHaveLength(5);
    const audit = (await get(`/api/runs/${run9}/audit`)).json();
    expect(audit.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "runtime.codex.failed", outcome: "timeout" })]));
    expect(audit.audit.every((row: { eventId: string }) => trace.json().events.some((event: { eventId: string }) => event.eventId === row.eventId))).toBe(true);
    expect((await get("/api/traces/trc_9/audit")).json().audit).toEqual(audit.audit);
    // #345: a malformed run id is a 400 contract violation on every run-id route; unknown UUIDs stay 404.
    expect((await get("/api/runs/nope/trace")).statusCode).toBe(400);
    expect((await get("/api/runs/019f3fa8-44d2-7b60-b413-1a0b2c3d4eff/trace")).statusCode).toBe(404);
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

  it("serves the runs list from stored summaries, scoped to the agent filter (#213)", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const agentId = "87654321-4321-4321-8321-cba987654321";
    const ids = { runId: "run-9", agentId, traceId: "trc_9" };
    emitter.emit({ ...ids, spanId: "root", type: "run.completed", category: "control", name: "run.completed", status: "ok", source: { component: "AgentService", observed: true } });
    await emitter.flush();
    // A fresh stored row (current rollup version, event count matches the index) must be served as-is —
    // the evaluation plane's outcome included — with no re-rollup write on the poll path.
    const fresh = summaryFromView(buildTrace(await store.readRun("run-9"), { capturePolicy: "metadata_only" }), { taskOutcome: "passed", taskOutcomeSource: "deterministic:eval-1" });
    const queries: unknown[] = [];
    const upserts: unknown[] = [];
    const summaries = {
      query: async (query: unknown) => { queries.push(query); return [fresh]; },
      upsert: async (summary: RunSummary) => { upserts.push(summary); return summary; },
    } as unknown as RunSummaryStore;
    const run = { id: "run-9", agentId, status: "completed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z" };
    const svc = { ...service, getRuns: () => [], listAgents: () => [{ id: agentId, name: "Nine" }], allRuns: () => [run] } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store, summaries });
    const filtered = await app.inject({ method: "GET", url: `/api/runs?agentId=${agentId}`, headers: auth });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().runs[0]).toMatchObject({
      runId: "run-9",
      status: "ok",
      taskOutcome: "passed",
      taskOutcomeSource: "deterministic:eval-1",
    });
    const unfiltered = await app.inject({ method: "GET", url: "/api/runs", headers: auth });
    expect(unfiltered.json().runs).toHaveLength(1);
    // #213: the summary read model is scoped to the same agent filter as the runs themselves.
    expect(queries).toEqual([{ agentId }, {}]);
    expect(upserts).toEqual([]);
    await app.close();
  });

  it("serves an Agent's rolling baseline from the newest terminal summaries", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const agentId = "87654321-4321-4321-8321-cba987654321";
    const makeSummary = (index: number): RunSummary => ({
      runId: `run-${index}`, traceId: `trace-${index}`, agentId, capturePolicy: "metadata_only",
      executionStatus: "completed", taskOutcome: "unknown", startedAt: `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
      durationMs: index * 1_000, metrics: { terminalStatus: "ok", toolCalls: index, toolFailures: 0, modelCalls: 1,
        tokens: { input: index * 100, output: index * 10 }, retries: 0, denials: 0 },
      usage: { inputTokens: index * 100, cachedInputTokens: index * 20, outputTokens: index * 10 }, denials: 0, actions: 0,
      capabilities: { model: "observed", tool: "observed" }, degraded: false, truncated: false, evicted: false,
      redactedEvents: 0, eventCount: 1, rollupVersion: 1, updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const queries: unknown[] = [];
    const summaries = { query: async (query: unknown) => { queries.push(query); return [makeSummary(3), makeSummary(2), makeSummary(1)]; } } as unknown as RunSummaryStore;
    const svc = { ...service, getAgent: (id: string) => { if (id !== agentId) throw new HttpError(404, "Agent not found"); return { id }; } } as unknown as AgentService;
    const app = await createApp(config({ GLASSBOX_PRICE_PER_MTOK_INPUT: "2", GLASSBOX_PRICE_PER_MTOK_CACHED_INPUT: "1", GLASSBOX_PRICE_PER_MTOK_OUTPUT: "4" }), svc, { emitter, store, summaries });
    const result = await app.inject({ method: "GET", url: `/api/agents/${agentId}/runs/baseline`, headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json().baseline).toMatchObject({ sampleCount: 3, windowSize: 20, durationMs: { p50: 2_000, p95: 3_000 }, inputTokens: { p50: 200, p95: 300 }, toolCalls: { p50: 2, p95: 3 }, estimatedCostUsd: { p50: 0.00044, p95: 0.00066 } });
    // #213: the store query is bounded so the Postgres backend never scans an Agent's whole history.
    expect(queries).toEqual([{ agentId, limit: 40 }]);
    expect((await app.inject({ method: "GET", url: "/api/agents/12345678-1234-4234-8234-123456789abc/runs/baseline", headers: auth })).statusCode).toBe(404);
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

  it("answers metric queries with provenance and rejects contract violations with 400", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const summary = { runId: "run-1", agentId: "agt-1", configHash: "cfg-a", executionStatus: "completed", taskOutcome: "unknown", startedAt: "2026-08-01T00:00:00.000Z", durationMs: 1000, denials: 0, updatedAt: "2026-08-01T00:00:00.000Z", metrics: { terminalStatus: "ok", toolCalls: 2, toolFailures: 0, modelCalls: 1, retries: 0, denials: 0, timeSplit: { modelMs: 0, toolMs: 0, containerStartMs: 0 } } };
    const summaries = { query: async () => [summary] } as unknown as RunSummaryStore;
    const evaluations = { getDefinition: async () => undefined, query: async () => [] } as unknown as EvaluationStore;
    const app = await createApp(config(), service, { emitter, store, summaries, evaluations });
    const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/metrics/query", headers: { ...auth, "content-type": "application/json" }, payload });

    const ok = await post({ metric: "latency", aggregation: { type: "p95" }, filter: { configHash: "cfg-a" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ schemaVersion: "1.0", capturePolicy: "metadata_only", kind: "telemetry", value: 1000, provenance: { count: 1, sampled: 1, runIds: ["run-1"], filter: { configHash: "cfg-a" } } });

    const unknown = await post({ metric: "vibes", aggregation: { type: "avg" } });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain("task_completion"); // the 400 lists the catalogue
    expect((await post({ metric: "denials", aggregation: { type: "p95" } })).statusCode).toBe(400);
    expect((await post({ metric: "task_completion", aggregation: { type: "rate" }, evaluator: { id: "nope" } })).statusCode).toBe(400);
    await app.close();

    // without both read models wired, the endpoint does not exist
    const bare = await createApp(config(), service, { emitter, store });
    expect((await bare.inject({ method: "POST", url: "/api/metrics/query", headers: { ...auth, "content-type": "application/json" }, payload: { metric: "latency", aggregation: { type: "p95" } } })).statusCode).toBe(404);
    await bare.close();
  });

  it("serves reliability aggregates and the configHash compare with provenance (#172)", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const agentId = "019f3fa8-44d2-7b60-b413-1a0b2c3d4e70";
    const metrics = { terminalStatus: "ok", toolCalls: 4, toolFailures: 1, modelCalls: 1, retries: 0, denials: 0, timeSplit: { modelMs: 0, toolMs: 0, containerStartMs: 0 } };
    const summary = (runId: string, configHash: string, startedAt: string, durationMs: number) =>
      ({ runId, agentId, configHash, executionStatus: "completed", taskOutcome: "unknown", startedAt, durationMs, denials: 0, updatedAt: startedAt, metrics }) as unknown as RunSummary;
    const rows = [summary("run-a", "cfg-a", "2026-08-01T00:00:00.000Z", 1000), summary("run-b", "cfg-b", "2026-08-02T00:00:00.000Z", 3000)];
    const summaries = { query: async (q: { configHash?: string }) => rows.filter((r) => !q.configHash || r.configHash === q.configHash) } as unknown as RunSummaryStore;
    const definition = { id: "task_completion", version: 2 };
    const evaluations = {
      getDefinition: async (id: string) => (id === "task_completion" ? definition : undefined),
      query: async () => [{ runId: "run-a", evaluatorId: "task_completion", evaluatorVersion: 2, passed: true, evaluatedAt: "2026-08-03T00:00:00.000Z" }],
    } as unknown as EvaluationStore;
    const svc = { ...service, getAgent: (id: string) => { if (id !== agentId) throw new HttpError(404, "Agent not found"); return { id }; } } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store, summaries, evaluations });

    const ok = await app.inject({ method: "GET", url: `/api/agents/${agentId}/reliability`, headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      schemaVersion: "1.0", capturePolicy: "metadata_only", agentId, runs: 2, executionCompletionRate: 1,
      taskCompletionRate: { evaluatorId: "task_completion", version: 2, evaluated: 1, passed: 1, rate: 1 },
      toolFailureRate: 2 / 8, latency: { p50: 1000, p95: 3000, sampled: 2 },
      provenance: { count: 2, runIds: ["run-a", "run-b"], filter: { agentId } },
    });
    expect(ok.json().series).toHaveLength(2); // one day bucket per Run by default

    const compare = await app.inject({ method: "GET", url: `/api/reliability/compare?agentId=${agentId}&a=cfg-a&b=cfg-b`, headers: auth });
    expect(compare.statusCode).toBe(200);
    expect(compare.json()).toMatchObject({
      a: { configHash: "cfg-a", runs: 1, taskCompletionRate: { evaluated: 1, passed: 1 } },
      b: { configHash: "cfg-b", runs: 1, taskCompletionRate: { evaluated: 0, passed: 0, rate: null } },
      deltas: { runs: 0, latency: { p50: 2000 }, taskCompletionRate: null },
    });

    expect((await app.inject({ method: "GET", url: "/api/agents/019f3fa8-44d2-7b60-b413-1a0b2c3d4e71/reliability", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/agents/${agentId}/reliability?bucket=week`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/agents/${agentId}/reliability?evaluatorId=nope`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/reliability/compare?agentId=${agentId}&a=cfg-a`, headers: auth })).statusCode).toBe(400);
    await app.close();

    // without both read models wired, the endpoints do not exist
    const bare = await createApp(config(), svc, { emitter, store });
    expect((await bare.inject({ method: "GET", url: `/api/agents/${agentId}/reliability`, headers: auth })).statusCode).toBe(404);
    await bare.close();
  });

  it("exposes evaluation jobs as an async boundary: enqueue 202, progress by poll, resume gated (#170)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evaluation-jobs-api-"));
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const json = new JsonStore(path.join(dir, "launchpad.json"));
    await json.initialize();
    const summaries = new JsonRunSummaryStore(json);
    const evaluations = new JsonEvaluationStore(json, summaries);
    await evaluations.initialize();
    const jobs = new EvaluationJobWorker({ jobs: new JsonEvaluationJobStore(json), summaries, evaluations, evaluators: builtinRunEvaluators() });
    const app = await createApp(config(), service, { emitter, store, summaries, evaluations, jobs });
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: { ...auth, "content-type": "application/json" }, payload: payload as Record<string, unknown> });

    expect((await post("/api/evaluation-jobs", { evaluatorId: "terminal_status", concurrency: 3 })).statusCode).toBe(400);
    expect((await post("/api/evaluation-jobs", { evaluatorId: "no-such" })).statusCode).toBe(404);
    expect((await post("/api/evaluation-jobs", { evaluatorId: "task_completion" })).statusCode).toBe(501); // no judge runtime until #171

    const accepted = await post("/api/evaluation-jobs", { evaluatorId: "terminal_status", filter: { executionStatus: "completed" } });
    expect(accepted.statusCode).toBe(202);
    const job = accepted.json().job;
    expect(job).toMatchObject({ evaluatorId: "terminal_status", evaluatorVersion: 1, status: "queued", force: false });

    const listed = await app.inject({ method: "GET", url: "/api/evaluation-jobs", headers: auth });
    expect(listed.json().jobs.map((item: { id: string }) => item.id)).toContain(job.id);
    const single = await app.inject({ method: "GET", url: `/api/evaluation-jobs/${job.id}`, headers: auth });
    expect(single.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/evaluation-jobs/019f3fa8-44d2-7b60-b413-1a0b2c3d4e99", headers: auth })).statusCode).toBe(404);
    // The empty selection settles quickly; wait so the store is quiescent before the rm below.
    for (let i = 0; i < 100; i++) {
      const polled = (await app.inject({ method: "GET", url: `/api/evaluation-jobs/${job.id}`, headers: auth })).json().job;
      if (polled.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Completed (not interrupted or failed), so not resumable.
    expect((await post(`/api/evaluation-jobs/${job.id}/resume`, {})).statusCode).toBe(409);
    await app.close();

    // without the worker wired, the endpoints do not exist
    const bare = await createApp(config(), service, { emitter, store });
    expect((await bare.inject({ method: "GET", url: "/api/evaluation-jobs", headers: auth })).statusCode).toBe(404);
    await bare.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates user-defined llm_judge evaluator definitions via POST /api/evaluators (#192)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "custom-evaluators-api-"));
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const json = new JsonStore(path.join(dir, "launchpad.json"));
    await json.initialize();
    const evaluations = new JsonEvaluationStore(json, new JsonRunSummaryStore(json));
    await evaluations.initialize();
    const app = await createApp(config(), service, { emitter, store, evaluations });
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/evaluators", headers: { ...auth, "content-type": "application/json" }, payload: payload as Record<string, unknown> });

    const body = { name: "Politeness Judge", rubric: "Score the final response for politeness.", minScore: 0, maxScore: 10, passThreshold: 7 };
    const created = await post(body);
    expect(created.statusCode).toBe(201);
    expect(created.json().evaluator).toMatchObject({ id: "politeness_judge", name: "Politeness Judge", version: 1, type: "llm_judge", minScore: 0, maxScore: 10, passThreshold: 7, setsTaskOutcome: false, config: {} });

    // FR-20: an identical body is idempotent; a changed rubric under the same name creates version n+1.
    expect((await post(body)).json().evaluator.version).toBe(1);
    const v2 = await post({ ...body, rubric: "Score politeness and warmth." });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().evaluator).toMatchObject({ id: "politeness_judge", version: 2 });
    // AC (#192): two versions of one user-defined evaluator coexist in the catalogue.
    const listed = (await app.inject({ method: "GET", url: "/api/evaluators", headers: auth })).json().evaluators
      .filter((item: { id: string }) => item.id === "politeness_judge")
      .map((item: { version: number }) => item.version)
      .sort();
    expect(listed).toEqual([1, 2]);

    // Validation at the boundary → 400 with details; type conflicts → 409.
    expect((await post({ ...body, passThreshold: 11 })).statusCode).toBe(400);
    expect((await post({ ...body, minScore: 10, maxScore: 0 })).statusCode).toBe(400);
    expect((await post({ ...body, rubric: "" })).statusCode).toBe(400);
    expect((await post({ ...body, name: "***" })).statusCode).toBe(400); // no usable slug
    expect((await post({ ...body, name: "Terminal Status" })).statusCode).toBe(409); // cannot turn a deterministic evaluator into a judge

    // AC (#192): a rubric mentioning a seeded fake secret is stored redacted.
    const secret = "sk-proj-" + "C".repeat(24);
    const leaky = await post({ ...body, name: "Leaky Judge", rubric: "Never reveal " + secret });
    expect(leaky.statusCode).toBe(201);
    expect(leaky.json().evaluator.rubric).not.toContain(secret);
    expect(await readFile(path.join(dir, "launchpad.json"), "utf8")).not.toContain(secret);

    // Privacy review of #313: the id is slugged from the REDACTED name — a secret pasted as the
    // name must not survive to the id, even dash/case-mangled by the slugger.
    const mangled = secret.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const leakyName = await post({ ...body, name: secret });
    expect(leakyName.statusCode).toBe(201);
    expect(leakyName.json().evaluator.id).not.toContain(mangled);
    expect((await readFile(path.join(dir, "launchpad.json"), "utf8")).includes(mangled)).toBe(false);

    // Every seeded judge id is reserved: an innocent "Task Completion" must not shadow task_completion@1,
    // and a user-authored recovery_quality@2 must not reach that id's runtime with its own setsTaskOutcome (#177).
    expect((await post({ ...body, name: "Task Completion" })).statusCode).toBe(409);
    expect((await post({ ...body, name: "Recovery Quality", setsTaskOutcome: true })).statusCode).toBe(409);
    await app.close();

    // without the evaluation store wired, the endpoint does not exist
    const bare = await createApp(config(), service, { emitter, store });
    expect((await bare.inject({ method: "POST", url: "/api/evaluators", headers: { ...auth, "content-type": "application/json" }, payload: body })).statusCode).toBe(404);
    await bare.close();
    await rm(dir, { recursive: true, force: true });
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

  it("rejects a malformed run id with 400 on every run-id route (#345)", async () => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const evaluations = { resultsForRun: async () => [] } as unknown as EvaluationStore;
    const svc = { ...service, getRun: () => { throw new HttpError(404, "Run not found"); } } as unknown as AgentService;
    const app = await createApp(config(), svc, { emitter, store, evaluations });
    for (const [method, url] of [
      ["GET", "/api/runs/not-a-uuid"],
      ["GET", "/api/runs/not-a-uuid/trace"],
      ["GET", "/api/runs/not-a-uuid/logs"],
      ["GET", "/api/runs/not-a-uuid/audit"],
      ["GET", "/api/runs/not-a-uuid/evaluations"],
      ["GET", "/api/runs/not-a-uuid/regression-case"],
      ["POST", "/api/runs/not-a-uuid/regression-case"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { ...auth, "content-type": "application/json" }, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
    }
    // A well-formed but unknown id is still a 404 lookup miss.
    expect((await app.inject({ method: "GET", url: "/api/runs/019f3fa8-44d2-7b60-b413-1a0b2c3d4eff/evaluations", headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it("rejects unknown keys in mutation bodies with 400 (#345)", async () => {
    const svc = {
      ...service,
      createAgent: async (input: unknown) => input,
      updateAgent: async (_id: string, input: unknown) => input,
      sendMessage: async () => ({ run: { id: "run-1" }, message: {} }),
    } as unknown as AgentService;
    const app = await createApp(config(), svc);
    const agentId = "2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b";
    const call = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) =>
      app.inject({ method, url, headers: { ...auth, "content-type": "application/json" }, payload });
    expect((await call("POST", "/api/agents", { name: "ok" })).statusCode).toBe(201);
    expect((await call("POST", "/api/agents", { name: "ok", surprise: true })).statusCode).toBe(400);
    expect((await call("POST", "/api/agents", { name: "ok", budget: { maxTokensPerDay: 1, surprise: true } })).statusCode).toBe(400);
    // partial() keeps the strict posture on the update body.
    expect((await call("PATCH", "/api/agents/" + agentId, { name: "ok" })).statusCode).toBe(200);
    expect((await call("PATCH", "/api/agents/" + agentId, { name: "ok", surprise: true })).statusCode).toBe(400);
    expect((await call("POST", "/api/agents/" + agentId + "/messages", { content: "hi" })).statusCode).toBe(202);
    expect((await call("POST", "/api/agents/" + agentId + "/messages", { content: "hi", surprise: true })).statusCode).toBe(400);
    await app.close();
  });
});
