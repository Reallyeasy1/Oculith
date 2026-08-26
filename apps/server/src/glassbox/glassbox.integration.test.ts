import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { ObservationEmitter } from "./emitter.js";
import { NdjsonTraceStore, type TraceStore } from "./store.js";

// Runtime-built fakes — never commit key-shaped literals (GitHub push protection scans file contents).
const ARK = ["ark", "0f0f0f0f", "1a1a", "4b4b", "8c8c", "d0d0d0d0d0d0", "0abc1"].join("-");
const OAI = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789";
const CANARY = "CANARY-SECRET-777";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class LeakyRunner implements AgentRunner {
  constructor(private readonly mode: "ok" | "throw" | "timeout") {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.mode === "throw") throw new Error("boom " + ARK + " Bearer " + OAI + " " + CANARY);
    if (this.mode === "timeout") throw new Error("Codex timed out after " + String(request.timeoutMs ?? 0) + " ms");
    return { output: "done " + OAI + " " + CANARY, threadId: "thr-" + ARK, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

async function harness(runner: AgentRunner, env: Record<string, string> = {}, store?: TraceStore) {
  const root = await mkdtemp(path.join(tmpdir(), "glassbox-int-"));
  dirs.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: ARK,
    ARK_MODEL: "ep-test",
    GLASSBOX_CAPTURE_POLICY: "safe_summary",
    ...env,
  });
  const traceStore = store ?? new NdjsonTraceStore(config.traceDirectory);
  await traceStore.initialize();
  const logs: string[] = [];
  const emitter = new ObservationEmitter({
    store: traceStore,
    capturePolicy: config.glassboxCapturePolicy,
    extraPatterns: [/CANARY-SECRET-\d+/g],
    log: (message, meta) => logs.push(message + " " + JSON.stringify(meta)),
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "ws")),
    runner,
    emitter,
  );
  await service.initialize();
  const app = await createApp(config, service, { emitter, store: traceStore });
  const agent = await service.createAgent({ name: "int", instructions: "keep " + OAI });
  const send = async (content: string) => {
    const res = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/messages", payload: { content } });
    const run = res.json().run;
    for (let i = 0; i < 300; i++) {
      if (["completed", "failed", "cancelled"].includes(service.getRun(run.id).status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await emitter.flush();
    return run.id as string;
  };
  return { config, service, app, emitter, logs, agent, send, traceStore };
}

const surfaces = async (h: Awaited<ReturnType<typeof harness>>, runId: string) => {
  // A 404 body is trivially secret-free, so every API surface must actually resolve.
  const ok = async (url: string) => { const res = await h.app.inject({ method: "GET", url }); expect(res.statusCode, url).toBe(200); return res.body; };
  return [
    await readFile(path.join(h.config.traceDirectory, runId + ".ndjson"), "utf8"),
    await ok("/api/runs/" + runId + "/trace"),
    await ok("/api/runs"),
    await ok("/api/traces/" + h.service.getRun(runId).traceId + "/export"),
    h.logs.join("\n"),
  ];
};

describe("AC-03 privacy across surfaces", () => {
  it.each([["success", "ok"], ["runner throws", "throw"]] as const)(
    "no seeded secret survives (%s)",
    async (_name, mode) => {
      const h = await harness(new LeakyRunner(mode));
      const runId = await h.send("please use " + ARK + " and " + OAI + " and " + CANARY);
      // Positive control: without this the "absent" assertions below would also pass if the seeded
      // secrets had simply never reached the observation plane.
      const trace = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json();
      expect(trace.summary.redactedEvents).toBeGreaterThan(0);
      expect((await readFile(path.join(h.config.traceDirectory, runId + ".ndjson"), "utf8"))).toContain("[REDACTED:");
      for (const surface of await surfaces(h, runId)) {
        expect(surface).not.toContain("0f0f0f0f");
        expect(surface).not.toContain("abcdefghijklmnop");
        expect(surface).not.toContain(CANARY);
      }
      await h.app.close();
    },
  );
});

describe("AC-05 degraded store", () => {
  it("Run reaches its real result and the trace reports degradation", async () => {
    const failing: TraceStore = {
      async initialize() {},
      async append() { throw new Error("EACCES"); },
      async readRun() { return []; },
      runIdForTrace() { return undefined; },
      listRuns() { return []; },
      markTruncated() {},
    };
    const h = await harness(new LeakyRunner("ok"), {}, failing);
    const runId = await h.send("hi");
    expect(h.service.getRun(runId).status).toBe("completed");
    expect(h.emitter.isDegraded(runId)).toBe(true);
    expect((await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json().summary.degraded).toBe(true);
    // Exactly one degradation log per Run — a per-event log storm would itself be a defect.
    expect(h.logs.filter((line) => line.startsWith("telemetry.degraded"))).toHaveLength(1);
    await h.app.close();
  });
});

describe("FR-11 gated failure fixture", () => {
  it("off by default: no timeout override reaches the runner", async () => {
    const seen: RunnerRequest[] = [];
    const spy: AgentRunner = {
      async run(request) { seen.push(request); return { output: "ok", threadId: null, usage: null }; },
      async cancel() { return false; },
      async isAvailable() { return true; },
    };
    const h = await harness(spy);
    await h.send("x");
    expect(seen[0]!.timeoutMs).toBeUndefined();
    await h.app.close();
  });

  it("GLASSBOX_DEMO_FAILURE=timeout yields a deterministic timeout trace twice", async () => {
    const h = await harness(new LeakyRunner("timeout"), { GLASSBOX_DEMO_FAILURE: "timeout" });
    const shapes: string[] = [];
    for (let index = 0; index < 2; index++) {
      const runId = await h.send("x");
      const view = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json();
      expect(view.summary.status).toBe("timeout");
      expect(view.summary.failure.kind).toBe("timeout");
      // The gate really reaches the runner: 3 s is the only timeout the fixture injects.
      expect(view.events.find((e: { type: string }) => e.type === "run.timed_out").error.message).toContain("3000");
      shapes.push(view.events.map((e: { type: string }) => e.type).join(","));
    }
    expect(shapes[0]).toBe(shapes[1]);
    await h.app.close();
  });
});

describe("AC-06 restart", () => {
  it("rebuilds the index and the interrupted Run reads as cancelled with incomplete spans", async () => {
    const hang: AgentRunner = {
      run: () => new Promise<RunnerResult>(() => undefined),
      async cancel() { return false; },
      async isAvailable() { return true; },
    };
    const h = await harness(hang);
    const res = await h.app.inject({ method: "POST", url: "/api/agents/" + h.agent.id + "/messages", payload: { content: "x" } });
    const runId = res.json().run.id as string;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.emitter.flush();
    await h.app.close();

    const store2 = new NdjsonTraceStore(h.config.traceDirectory);
    await store2.initialize();
    const emitter2 = new ObservationEmitter({ store: store2, capturePolicy: "metadata_only" });
    for (const entry of store2.listRuns()) emitter2.seedSequence(entry.traceId, entry.lastSequence);
    const service2 = new AgentService(
      h.config,
      new JsonStore(path.join(h.config.dataDirectory, "db.json")),
      new WorkspaceManager(path.join(path.dirname(h.config.dataDirectory), "ws")),
      new LeakyRunner("ok"),
      emitter2,
    );
    await service2.initialize();
    await emitter2.flush();
    const app2 = await createApp(h.config, service2, { emitter: emitter2, store: store2 });
    const view = (await app2.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json();
    expect(view.summary.status).toBe("cancelled");
    expect(view.summary.incompleteSpans).toBeGreaterThan(0);
    expect(view.events.at(-1).attributes.reason).toBe("server_restart");
    expect(view.events.map((e: { sequence: number }) => e.sequence)).toEqual([...view.events.keys()]);
    await app2.close();
  });
});
