import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { parseCodexEventLine, type ParsedEvents } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { RunLogStore } from "../run-log-store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { ObservationEmitter } from "./emitter.js";
import { CodexStreamObserver } from "./codex-observer.js";
import { newId } from "./schema.js";
import { NdjsonTraceStore, type TraceStore } from "./store.js";
import { JsonRunSummaryStore, rollupRun } from "./summary.js";

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

async function harness(runner: AgentRunner | ((emitter: ObservationEmitter) => AgentRunner), env: Record<string, string> = {}, store?: TraceStore) {
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
  const runLogStore = new RunLogStore(
    path.join(config.dataDirectory, "logs"),
    config.glassboxLogMaxMb * 1024 * 1024,
    3,
    [/CANARY-SECRET-\d+/g],
  );
  await runLogStore.initialize();
  const logs: string[] = [];
  const emitter = new ObservationEmitter({
    store: traceStore,
    capturePolicy: config.glassboxCapturePolicy,
    extraPatterns: [/CANARY-SECRET-\d+/g],
    log: (message, meta) => logs.push(message + " " + JSON.stringify(meta)),
  });
  const resolvedRunner = typeof runner === "function" ? runner(emitter) : runner;
  const jsonStore = new JsonStore(path.join(root, "data", "db.json"));
  // Summary store wired like index.ts (#255) so the budget gate has its read model. Rollups stay
  // explicit (rollupRun in the test) — a background scheduleRollup would race the temp-dir teardown.
  const summaries = new JsonRunSummaryStore(jsonStore);
  const service = new AgentService(
    config,
    jsonStore,
    new WorkspaceManager(path.join(root, "ws")),
    resolvedRunner,
    emitter,
    undefined,
    runLogStore,
    summaries,
  );
  await service.initialize();
  const app = await createApp(config, service, { emitter, store: traceStore, summaries, logs: runLogStore });
  const agent = await service.createAgent({ name: "int", instructions: "keep " + OAI });
  const send = async (content: string) => {
    const res = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/messages", payload: { content } });
    const run = res.json().run;
    for (let i = 0; i < 300; i++) {
      if (["completed", "failed", "cancelled"].includes(service.getRun(run.id).status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await emitter.flush();
    await runLogStore.flush();
    return run.id as string;
  };
  return { config, service, app, emitter, logs, agent, send, traceStore, runLogStore, summaries };
}

const surfaces = async (h: Awaited<ReturnType<typeof harness>>, runId: string) => {
  // A 404 body is trivially secret-free, so every API surface must actually resolve.
  const ok = async (url: string) => { const res = await h.app.inject({ method: "GET", url }); expect(res.statusCode, url).toBe(200); return res.body; };
  return [
    await readFile(path.join(h.config.traceDirectory, runId + ".ndjson"), "utf8"),
    await ok("/api/runs/" + runId + "/trace"),
    await ok("/api/runs/" + runId + "/audit"),
    await ok("/api/runs"),
    await ok("/api/traces/" + h.service.getRun(runId).traceId + "/audit"),
    await readFile(path.join(h.config.dataDirectory, "logs", "server.ndjson"), "utf8"),
    await ok("/api/runs/" + runId + "/logs"),
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
      const runLogs = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/logs" })).json().lines;
      expect(runLogs.every((line: Record<string, unknown>) => !("runId" in line) && !("traceId" in line) && !("agentId" in line))).toBe(true);
      if (mode === "throw") expect(JSON.stringify(runLogs)).toContain("[REDACTED:");
      for (const surface of await surfaces(h, runId)) {
        expect(surface).not.toContain("0f0f0f0f");
        expect(surface).not.toContain("abcdefghijklmnop");
        expect(surface).not.toContain(CANARY);
      }
      await h.app.close();
    },
  );
});

describe("P0 verification invariants", () => {
  it("projects a captured sandbox denial into audit and hand-computed per-Run metrics", async () => {
    const h = await harness((emitter) => ({
      async run(request) {
        const observer = new CodexStreamObserver(emitter, request.trace!, request.trace!.parentSpanId, "CodexRunner");
        const parsed: ParsedEvents = { messages: [], threadId: null, usage: null, errors: [] };
        const fixture = await readFile(path.join(process.cwd(), "..", "..", "fixtures", "codex-stream", "codex-0.142-sandbox-denied.jsonl"), "utf8");
        for (const line of fixture.split(/\r?\n/)) if (line.trim()) parseCodexEventLine(line, parsed, observer);
        observer.finish("ok");
        return { output: parsed.messages.at(-1) ?? "done", threadId: parsed.threadId, usage: parsed.usage };
      },
      async cancel() { return false; },
      async isAvailable() { return true; },
    }));
    const runId = await h.send("exercise the captured denial");
    const view = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json();
    const audit = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/audit" })).json().audit;
    const eventIds = new Set(view.events.map((event: { eventId: string }) => event.eventId));
    expect(view.events.some((event: { type: string }) => event.type === "policy.denied")).toBe(true);
    expect(audit.some((row: { outcome: string }) => row.outcome === "denied")).toBe(true);
    expect(audit.every((row: { eventId: string; spanId: string }) => eventIds.has(row.eventId) && view.events.some((event: { spanId: string }) => event.spanId === row.spanId))).toBe(true);

    const toolSpanIds = new Set(view.events.filter((event: { type: string }) => event.type.startsWith("tool.call.")).map((event: { spanId: string }) => event.spanId));
    // #207: per-call granularity — each completed turn carries the observed reasoning/agent_message
    // count, and a turn that ran counts as at least one call. The capture holds two pairs in one turn.
    const observedModelCalls = view.events
      .filter((event: { type: string }) => event.type === "model.completed")
      .reduce((total: number, event: { attributes: Record<string, unknown> }) => {
        const observed = event.attributes.modelCallsObserved;
        return total + Math.max(1, typeof observed === "number" ? observed : 0);
      }, 0);
    expect(observedModelCalls).toBe(2);
    expect(view.summary.metrics).toMatchObject({
      toolCalls: toolSpanIds.size,
      toolFailures: new Set(view.events.filter((event: { type: string }) => event.type === "tool.call.failed").map((event: { spanId: string }) => event.spanId)).size,
      modelCalls: observedModelCalls,
      denials: view.events.filter((event: { type: string }) => event.type === "policy.denied").length,
    });
    // #130/#129 metrics, hand-computed from the same evidence: bounded tool identities and the tool time of the split.
    type SpanLike = { category: string; durationMs?: number; attributes: Record<string, unknown>; children?: SpanLike[] };
    const flatten = (spans: SpanLike[]): SpanLike[] => spans.flatMap((span) => [span, ...flatten(span.children ?? [])]);
    const toolSpans = flatten(view.spans).filter((span) => span.category === "tool");
    expect(toolSpans).toHaveLength(toolSpanIds.size);
    const identities = [...new Set(toolSpans.map((span) => [span.attributes.program, span.attributes.argument0].filter((part) => typeof part === "string" && part).join(" ")).filter(Boolean))].slice(0, 3);
    expect(view.summary.metrics.toolIdentities).toEqual(identities);
    expect(view.summary.metrics.timeSplit.toolMs).toBe(toolSpans.reduce((total, span) => total + (span.durationMs ?? 0), 0));
    expect(view.summary.configHash).toMatch(/^[0-9a-f]{16}$/);
    const listed = (await h.app.inject({ method: "GET", url: "/api/runs" })).json().runs.find((run: { runId: string }) => run.runId === runId);
    expect(listed).toMatchObject({ denials: view.summary.denials, configHash: view.summary.configHash, toolCalls: view.summary.metrics.toolCalls, toolFailures: view.summary.metrics.toolFailures });
    expect(listed.toolIdentities).toEqual(view.summary.metrics.toolIdentities);
    await h.app.close();
  });
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

  // Shape determinism leans on an ordering the code guarantees only indirectly (#54): the POST responds
  // (onResponse emits http.request.completed) before executeRun's first store.mutate finishes, so the
  // ingress end always lands ahead of run.started. If executeRun ever emits before that mutate, or the
  // response is delayed past it, the two shapes below will (rightly) stop matching.
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
    // Opens a runtime span like the real runners do, then never returns — the restart must cut it off.
    // Resolve when the runner is reached: executeRun awaits workspace writes first, so a fixed sleep would
    // restart too early under load and later control events would follow the cancel marker.
    let reached!: () => void;
    const runnerReached = new Promise<void>((resolve) => { reached = resolve; });
    const hang: AgentRunner = {
      run: (request) => {
        reached();
        h.emitter.startSpan({ ...request.trace!, spanId: newId("spn"), type: "runtime.codex.started", category: "runtime", name: "codex exec", source: { component: "AgentRunner", observed: true } });
        return new Promise<RunnerResult>(() => undefined);
      },
      async cancel() { return false; },
      async isAvailable() { return true; },
    };
    const h = await harness(hang);
    const res = await h.app.inject({ method: "POST", url: "/api/agents/" + h.agent.id + "/messages", payload: { content: "x" } });
    const runId = res.json().run.id as string;
    await runnerReached;
    await h.emitter.flush();
    const originalConfigHash = h.service.getRun(runId).configHash;
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
    expect(service2.getRun(runId).configHash).toBe(originalConfigHash);
    expect(view.summary.configHash).toBe(originalConfigHash);
    expect(view.summary.incompleteSpans).toBeGreaterThan(0);
    expect(view.events.at(-1).attributes.reason).toBe("server_restart");
    expect(view.events.map((e: { sequence: number }) => e.sequence)).toEqual([...view.events.keys()]);
    // Focus lands on the runtime span the restart cut off, not the synthetic cancel; the clock stops at the last observed event.
    expect(view.summary.failure.name).toBe("codex exec");
    expect(view.summary.failure.category).toBe("runtime");
    expect(view.summary.failure.path.at(-1)).toBe(view.summary.failure.spanId);
    expect(view.summary.failure.path.length).toBeGreaterThan(1);
    expect(view.summary.firstFailingStep).toBe("codex exec");
    expect(view.summary.failure.diagnosis).toContain("interrupted by a server restart");
    expect(view.summary.endedReason).toBe("server_restart");
    expect(view.summary.endedAt).toBe(view.events.at(-1).timestamp);
    expect(view.summary.durationMs).toBe(Date.parse(view.events.at(-2).timestamp) - Date.parse(view.events[0].timestamp));
    await app2.close();
  });
});

describe("#255 pre-run budget gate over HTTP", () => {
  it("refuses the next Run with 429 after real usage reaches the cap, leaving a complete refusal trace", async () => {
    // Each Run leaves one observed model.completed with 1 in + 1 out token — the gate must count only
    // what the rollup derived from stored events, exactly like a real Codex turn.
    const h = await harness((emitter) => ({
      async run(request: RunnerRequest): Promise<RunnerResult> {
        emitter.emit({
          traceId: request.trace!.traceId, spanId: newId("spn"), parentSpanId: request.trace!.parentSpanId,
          runId: request.trace!.runId, agentId: request.trace!.agentId,
          type: "model.completed", category: "model", name: "model.completed", status: "ok",
          source: { component: "CodexRunner", adapter: "codex-observer", observed: true },
          attributes: { inputTokens: 1, outputTokens: 1 },
        });
        return { output: "done", threadId: "thr-budget", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async cancel() { return false; },
      async isAvailable() { return true; },
    }));
    await h.service.updateAgent(h.agent.id, { budget: { maxTokensPerDay: 2 } });
    const firstRunId = await h.send("spend the whole budget");
    // The gate reads stored rollups; in production scheduleRollup runs after the terminal event.
    await rollupRun({ traces: h.traceStore, emitter: h.emitter, summaries: h.summaries }, firstRunId);
    expect((await h.summaries.get(firstRunId))?.executionStatus).toBe("completed");

    const refused = await h.app.inject({ method: "POST", url: "/api/agents/" + h.agent.id + "/messages", payload: { content: "one more" } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toMatch(/Budget exceeded/);
    await h.emitter.flush();

    // The refusal is evidence on its own trace — received → policy.denied → run.refused →
    // completed(429) — with no Run row, and the 429 body names the trace so it is reachable.
    const refusedEntry = h.traceStore.listRuns().find((entry) => entry.runId !== firstRunId);
    expect(refusedEntry).toBeTruthy();
    expect(refused.json().error).toContain(refusedEntry!.traceId);
    const events = await h.traceStore.readRun(refusedEntry!.runId);
    expect(events.map((e) => e.type)).toEqual(["http.request.received", "policy.denied", "run.refused", "http.request.completed"]);
    expect(events[1]).toMatchObject({
      category: "policy", status: "error", name: "budget.pre_run_gate",
      attributes: { decision: "budget_exceeded", limit: "maxTokensPerDay", limitValue: 2, used: 2 },
    });
    expect(events[3]).toMatchObject({ attributes: { statusCode: 429 } });
    expect(() => h.service.getRun(refusedEntry!.runId)).toThrow();
    // run.refused makes the trace terminal: retention can evict it, and the rollup ignores it —
    // a refusal must never appear as a Run in the reliability read model.
    expect(refusedEntry!.status).not.toBe("running");
    expect(await rollupRun({ traces: h.traceStore, emitter: h.emitter, summaries: h.summaries }, refusedEntry!.runId)).toBeUndefined();
    // The trace view serves the refusal, and its diagnosis names the observed actor — never the sandbox.
    const refusalView = (await h.app.inject({ method: "GET", url: "/api/traces/" + refusedEntry!.traceId }));
    expect(refusalView.statusCode).toBe(200);
    expect(refusalView.json().summary.failure?.diagnosis).toContain("budget gate refused the request");
    expect(refusalView.json().summary.failure?.diagnosis).not.toContain("sandbox");

    // The banner endpoint agrees with the gate.
    const status = await h.app.inject({ method: "GET", url: "/api/agents/" + h.agent.id + "/budget" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      budget: { maxTokensPerDay: 2 }, exceeded: true,
      usage: { totalTokens: 2, runs: 1 }, denial: { limit: "maxTokensPerDay", limitValue: 2, used: 2 },
    });

    // Clearing the budget re-opens the lane immediately.
    await h.service.updateAgent(h.agent.id, { budget: null });
    const allowed = await h.app.inject({ method: "POST", url: "/api/agents/" + h.agent.id + "/messages", payload: { content: "after clearing" } });
    expect(allowed.statusCode).toBe(202);
    // Let the accepted Run reach a terminal state before teardown removes its temp directories.
    await h.service.waitForRun(allowed.json().run.id);
    await h.emitter.flush();
    await h.app.close();
  });
});
