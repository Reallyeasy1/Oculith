import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, configHash, configSnapshot } from "./agent-service.js";
import { EvalRunner } from "./eval/runner.js";
import { RunCancelledError } from "./errors.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentConfigSnapshot, AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { createTraceContext } from "./glassbox/context.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore, type TraceStore } from "./glassbox/store.js";
import { JsonEvaluationStore } from "./glassbox/evaluation.js";
import { JsonRunSummaryStore } from "./glassbox/summary.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  // A deliberately non-settling FakeRunner can be between scheduling its run and writing AGENTS.md.
  // Let that microtask reach the runner before removing its temporary workspace.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("validates, lists, shares, and switches named workspaces safely", async () => {
    let finish!: (result: RunnerResult) => void;
    const runner: AgentRunner = {
      run: () => new Promise((resolve) => { finish = resolve; }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const first = await service.createAgent({ name: "One", workspace: "shared-repo" });
    const second = await service.createAgent({ name: "Two", workspace: "shared-repo" });
    expect(first.workspacePath).toBe(second.workspacePath);
    expect((await service.listWorkspaces()).find((workspace) => workspace.name === "shared-repo")).toMatchObject({
      agents: expect.arrayContaining([first.id, second.id]), managed: false,
    });

    const { run } = await service.sendMessage(first.id, "hold");
    await expect.poll(() => readFile(path.join(first.workspacePath, "AGENTS.md"), "utf8")).toMatch(/named One/);
    await expect(service.sendMessage(second.id, "collide")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.updateAgent(second.id, { workspace: "next-repo" })).resolves.toMatchObject({ workspaceName: "next-repo", codexThreadId: null });
    expect(await readFile(path.join(service.getAgent(second.id).workspacePath, "AGENTS.md"), "utf8")).toContain("Two");
    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.deleteAgent(first.id);
    await expect(stat(first.workspacePath)).resolves.toBeDefined();
  });

  it.each(["../escape", "UPPER", "/absolute", "a/b", "a\\b", ""])("rejects unsafe workspace name %j", async (workspace) => {
    const service = await makeService();
    await expect(service.createAgent({ name: "Unsafe", workspace })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("briefs new and existing Agents about disposable containers and host-side commands", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Frontend Builder" });
    const instructionsPath = path.join(agent.workspacePath, "AGENTS.md");
    const expected = [
      "no process you start survives this turn",
      "Never tell the user to open a localhost URL you started",
      "leave build output in the workspace",
      "state the exact command the user runs on their own machine",
    ];
    const initial = await readFile(instructionsPath, "utf8");
    for (const text of expected) expect(initial).toContain(text);

    await writeFile(instructionsPath, "stale platform instructions", "utf8");
    await service.initialize();
    const refreshed = await readFile(instructionsPath, "utf8");
    for (const text of expected) expect(refreshed).toContain(text);
    expect(refreshed).toContain("This file is regenerated when the Agent configuration is updated.");
  });

  it("stamps stable behavior configuration and changes the hash when instructions change", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Versioned", instructions: "Run tests" });
    const first = (await service.sendMessage(agent.id, "first")).run;
    await expect.poll(() => service.getRun(first.id).status).toBe("completed");
    const second = (await service.sendMessage(agent.id, "second")).run;
    await expect.poll(() => service.getRun(second.id).status).toBe("completed");
    expect(second.configHash).toBe(first.configHash);
    expect(second.configSnapshot).toEqual(first.configSnapshot);

    await service.updateAgent(agent.id, { instructions: "Skip tests" });
    const changed = (await service.sendMessage(agent.id, "third")).run;
    await expect.poll(() => service.getRun(changed.id).status).toBe("completed");
    expect(changed.configHash).not.toBe(first.configHash);
    expect(changed.configSnapshot?.instructions).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(changed.configSnapshot?.instructions).not.toContain("Skip tests");
    expect(JSON.stringify(changed.configSnapshot)).not.toMatch(/apiKey|token|secret|password/i);
  });

  it("hashes canonical configuration independently of object key insertion order", () => {
    const agent = { id: "a", name: "A", description: "", instructions: "Run tests", status: "ready", workspacePath: ".", codexThreadId: null, lastError: null, createdAt: "", updatedAt: "" } as const;
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "secret", ARK_MODEL: "model" });
    const snapshot = configSnapshot(agent, config);
    const reordered = {
      capturePolicy: snapshot.capturePolicy,
      containerRuntimeImage: snapshot.containerRuntimeImage,
      runtimeProvider: snapshot.runtimeProvider,
      codexSandboxMode: snapshot.codexSandboxMode,
      model: snapshot.model,
      modelProvider: snapshot.modelProvider,
      instructions: snapshot.instructions,
    } satisfies AgentConfigSnapshot;
    expect(configHash(reordered)).toBe(configHash(snapshot));
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

});

class TimeoutRunner extends FakeRunner {
  override async run(): Promise<RunnerResult> {
    throw new Error("Codex timed out after 3000 ms");
  }
}

async function makeTraced(runner: AgentRunner = new FakeRunner(), store: TraceStore = new MemoryTraceStore()) {
  const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const jsonStore = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory);
  const service = new AgentService(config, jsonStore, workspaces, runner, emitter);
  await service.initialize();
  return { service, store, emitter, config, jsonStore, workspaces };
}

const settle = async (service: AgentService, runId: string) => {
  for (let i = 0; i < 50; i++) {
    const r = service.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(r.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not settle");
};

describe("GlassBox control-plane adapter", () => {
  it("runs persisted regression cases serially through isolated ordinary Runs", async () => {
    const { service, store, emitter, config, jsonStore } = await makeTraced();
    const summaries = new JsonRunSummaryStore(jsonStore);
    const evaluations = new JsonEvaluationStore(jsonStore, summaries);
    await evaluations.initialize();
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    const agent = await service.createAgent({ name: "Eval target", instructions: "complete the task" });
    const snapshot = configSnapshot(agent, config);
    const regressionCase = await service.createRegressionCase({ name: "case", prompt: "do it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }] });
    expect(regressionCase.templateHash).toMatch(/^[0-9a-f]{64}$/);
    const evalRun = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } });
    expect(evalRun).toMatchObject({ templateHashes: { fixture: regressionCase.templateHash } });
    expect(evalRun.templateHashMismatch).toBeUndefined();
    await new EvalRunner(service, { emitter, store, summaries, evaluations }).execute(evalRun.id);
    const finished = service.getEvalRun(evalRun.id);
    expect(finished).toMatchObject({ status: "completed", runIds: [expect.any(String)] });
    expect(finished.results[0]).toMatchObject({ caseId: regressionCase.id, runId: finished.runIds[0], results: [expect.objectContaining({ type: "terminal_status", pass: true })] });
    expect(await evaluations.resultsForRun(finished.runIds[0]!)).toEqual([expect.objectContaining({ evaluatorId: "terminal_status", evaluatorVersion: 1, passed: true, jobId: evalRun.id })]);
    await emitter.flush();
    expect((await store.readRun(finished.runIds[0]!)).find((event) => event.type === "run.created")?.attributes).toMatchObject({ evalRunId: evalRun.id, caseId: regressionCase.id, templateHash: regressionCase.templateHash });
  });

  it("refuses an EvalRun whose template changed since the case was recorded unless forced", async () => {
    const { service, config, jsonStore } = await makeTraced();
    const template = path.join(config.workspaceTemplatesDirectory, "fixture");
    await mkdir(template, { recursive: true });
    await writeFile(path.join(template, "starting.txt"), "v1", "utf8");
    const agent = await service.createAgent({ name: "Eval target", instructions: "complete the task" });
    const snapshot = configSnapshot(agent, config);
    const target = { agentId: agent.id, snapshot, configHash: configHash(snapshot) };
    const regressionCase = await service.createRegressionCase({ name: "case", prompt: "do it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }] });
    await writeFile(path.join(template, "starting.txt"), "v2", "utf8");
    await expect(service.createEvalRun({ caseIds: [regressionCase.id], target })).rejects.toMatchObject({ statusCode: 409, message: "template changed since the case was recorded" });
    const forced = await service.createEvalRun({ caseIds: [regressionCase.id], target }, { force: true });
    expect(forced.templateHashMismatch).toBe(true);
    expect(forced.templateHashes!.fixture).not.toBe(regressionCase.templateHash);
    // a case saved before hashes existed is unknown, never refused
    await service.createRegressionCase({ name: "legacy", prompt: "do it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }] });
    const legacy = service.listRegressionCases().find((item) => item.name === "legacy")!;
    await jsonStore.mutate((database) => { delete database.regressionCases.find((item) => item.id === legacy.id)!.templateHash; });
    await writeFile(path.join(template, "starting.txt"), "v3", "utf8");
    expect((await service.createEvalRun({ caseIds: [legacy.id], target })).templateHashMismatch).toBeUndefined();
    await expect(service.createRegressionCase({ name: "missing", prompt: "x", workspaceTemplate: "nope", baselineConfigHash: "b", assertions: [{ type: "terminal_status", expected: "ok" }] })).rejects.toMatchObject({ statusCode: 400 });
    // a template deleted after the case was recorded is a 400 at EvalRun creation, not a 500
    await rm(template, { recursive: true, force: true });
    await expect(service.createEvalRun({ caseIds: [regressionCase.id], target })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("records a throwing case and still runs the remaining cases", async () => {
    let calls = 0;
    const { service, store, emitter, config } = await makeTraced(
      new (class extends FakeRunner {
        override run(request: RunnerRequest): Promise<RunnerResult> {
          if (calls++ === 0) return Promise.reject(new Error("runner exploded"));
          return super.run(request);
        }
      })(),
    );
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    const agent = await service.createAgent({ name: "Eval target", instructions: "complete the task" });
    const snapshot = configSnapshot(agent, config);
    const assertions = [{ type: "terminal_status" as const, expected: "ok" }];
    const first = await service.createRegressionCase({ name: "first", prompt: "one", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions });
    const second = await service.createRegressionCase({ name: "second", prompt: "two", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions });
    const evalRun = await service.createEvalRun({ caseIds: [first.id, second.id], target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } });
    await new EvalRunner(service, { emitter, store }).execute(evalRun.id);
    const finished = service.getEvalRun(evalRun.id);
    expect(finished.status).toBe("failed");
    expect(finished.completedAt).toEqual(expect.any(String));
    expect(finished.results).toHaveLength(2);
    expect(finished.results[0]).toMatchObject({ caseId: first.id, runId: expect.any(String), error: "runner exploded", results: [expect.objectContaining({ type: "terminal_status", pass: false })] });
    expect(service.getRun(finished.results[0]!.runId!)).toMatchObject({ status: "failed", error: "runner exploded" });
    expect(finished.results[1]).toMatchObject({ caseId: second.id, runId: expect.any(String), results: [expect.objectContaining({ type: "terminal_status", pass: true })] });
    expect(finished.results[1]!.results[0]!.pass).toBe(true);
    expect(service.getAgent(agent.id).status).not.toBe("busy");
    // the Agent went error -> ready, so the next ordinary message is still admitted; wait so cleanup does not race the store
    const { run: next } = await service.sendMessage(agent.id, "still admitted");
    expect(await service.waitForRun(next.id)).toMatchObject({ status: "completed" });
  });

  it("runs an evaluation in a fresh template workspace and leaves the Agent thread untouched", async () => {
    class CapturingRunner extends FakeRunner {
      requests: RunnerRequest[] = [];
      instructions = "";
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        this.requests.push(request);
        this.instructions = await readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8");
        return super.run(request);
      }
    }
    const runner = new CapturingRunner();
    const { service, store, emitter, config, workspaces } = await makeTraced(runner);
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    await writeFile(path.join(config.workspaceTemplatesDirectory, "fixture", "starting.txt"), "template starting state", "utf8");
    const agent = await service.createAgent({ name: "Evaluator", instructions: "Run the supplied regression case." });
    const normal = (await service.sendMessage(agent.id, "establish a normal thread")).run;
    await settle(service, normal.id);
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");

    const { run } = await service.runIsolated({
      agentId: agent.id,
      workspaceTemplate: "fixture",
      prompt: "evaluate the case",
      tags: { evalRunId: "eval-1", caseId: "case-1" },
    });
    await settle(service, run.id);
    await emitter.flush();

    const isolatedRequest = runner.requests.at(-1)!;
    expect(isolatedRequest.workspacePath).toContain(path.join(".eval", run.id));
    expect(isolatedRequest.workspacePath).not.toBe(agent.workspacePath);
    expect(isolatedRequest.threadId).toBeNull();
    expect(runner.instructions).toContain("Run the supplied regression case.");
    await expect(readFile(path.join(agent.workspacePath, "starting.txt"), "utf8")).rejects.toThrow();
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(service.getMessages(agent.id)).toHaveLength(2); // the isolated prompt/output never enter normal chat history
    await expect.poll(async () => stat(isolatedRequest.workspacePath).then(() => true, () => false)).toBe(false);

    const created = (await store.readRun(run.id)).find((event) => event.type === "run.created");
    expect(created?.attributes).toMatchObject({ evalRunId: "eval-1", caseId: "case-1", configHash: run.configHash, templateHash: await workspaces.templateHash("fixture") });
  });

  it("links the Run to a trace and emits root, control and terminal events in order", async () => {
    const { service, store, emitter } = await makeTraced();
    const agent = await service.createAgent({ name: "traced" });
    const ctx = createTraceContext(
      { requestId: "req-1", method: "POST", path: "/api/agents/x/messages" },
      "metadata_only",
    );
    const { run } = await service.sendMessage(agent.id, "hello", ctx);
    expect(ctx.runId).toBe(run.id);
    expect(service.getRun(run.id).traceId).toBe(ctx.traceId);
    await settle(service, run.id);
    await emitter.flush();
    const events = await store.readRun(run.id);
    expect(events.map((e) => e.type)).toEqual([
      "http.request.received",
      "run.created",
      "agent_service.run.started",
      "run.started",
      "workspace.changed",
      "run.completed",
      "agent_service.run.completed",
    ]);
    expect(events[1]!.parentSpanId).toBe(ctx.rootSpanId);
    expect(events[1]!.attributes.configHash).toBe(service.getRun(run.id).configHash);
    expect(events[2]!.parentSpanId).toBe(ctx.rootSpanId);
    expect(events.every((e) => e.traceId === ctx.traceId && e.requestId === "req-1")).toBe(true);
    expect(events.find((e) => e.type === "run.completed")!.attributes).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(JSON.stringify(events)).not.toContain("hello"); // prompt text is never stored
  });

  it("observes workspace path changes without storing file contents", async () => {
    const { service, store, emitter } = await makeTraced(new (class extends FakeRunner {
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "result.txt"), "secret file contents", "utf8");
        return super.run(request);
      }
    })());
    const agent = await service.createAgent({ name: "workspace observer" });
    const { run } = await service.sendMessage(agent.id, "write a result");
    await settle(service, run.id);
    await emitter.flush();
    const changed = (await store.readRun(run.id)).find((event) => event.type === "workspace.changed");
    expect(changed).toMatchObject({ attributes: { added: 1, modified: 0, removed: 0, paths: "result.txt" } });
    expect(JSON.stringify(changed)).not.toContain("secret file contents");
  });

  it("emits run.started only once the Run is really running", async () => {
    // The emitter appends on the microtask queue, i.e. before any disk write settles, so the Run
    // status seen at append time is the status at emit time.
    const seen: Record<string, string> = {};
    let service!: AgentService;
    const inner = new MemoryTraceStore();
    const store: TraceStore = {
      initialize: () => inner.initialize(),
      append: (event) => {
        seen[event.type] = service.getRun(event.runId).status;
        return inner.append(event);
      },
      readRun: (runId) => inner.readRun(runId),
      runIdForTrace: (traceId) => inner.runIdForTrace(traceId),
      listRuns: () => inner.listRuns(),
      markTruncated: (runId) => inner.markTruncated(runId),
    };
    const traced = await makeTraced(new FakeRunner(), store);
    service = traced.service;
    const agent = await service.createAgent({ name: "order" });
    const { run } = await service.sendMessage(agent.id, "x");
    await settle(service, run.id);
    await traced.emitter.flush();
    expect(seen["run.created"]).toBe("queued");
    expect(seen["agent_service.run.started"]).toBe("running");
    expect(seen["run.started"]).toBe("running");
  });

  it("classifies a runner timeout as timeout", async () => {
    const { service, store, emitter } = await makeTraced(new TimeoutRunner());
    const agent = await service.createAgent({ name: "t" });
    const { run } = await service.sendMessage(agent.id, "x");
    await settle(service, run.id);
    await emitter.flush();
    const events = await store.readRun(run.id);
    expect(events.map((e) => e.type)).toContain("run.timed_out");
    expect(events.at(-1)).toMatchObject({ type: "agent_service.run.failed", status: "timeout" });
  });

  it("restart marks interrupted Runs cancelled in the trace", async () => {
    // Wait for the runner to be reached instead of sleeping: executeRun awaits workspace writes first, so a
    // fixed delay restarts too early under load and later control events would follow the cancel marker.
    let reached!: () => void;
    const runnerReached = new Promise<void>((resolve) => { reached = resolve; });
    const { service, store, emitter, config, jsonStore, workspaces } = await makeTraced(
      new (class extends FakeRunner {
        override run(): Promise<RunnerResult> {
          reached();
          return new Promise(() => undefined);
        }
      })(),
    );
    const agent = await service.createAgent({ name: "r" });
    const snapshot = configSnapshot(agent, config);
    const evalRun = await service.createEvalRun({ caseIds: [], target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } });
    const { run } = await service.sendMessage(agent.id, "x");
    await runnerReached;
    await emitter.flush();
    // a second service on the same store simulates a process restart
    const restarted = new AgentService(config, jsonStore, workspaces, new FakeRunner(), emitter);
    await restarted.initialize();
    await emitter.flush();
    expect(restarted.getEvalRun(evalRun.id)).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      results: [{ caseId: "", results: [], error: "Server restarted while this Eval Run was active" }],
    });
    const events = await store.readRun(run.id);
    const serviceSpan = events.find((event) => event.type === "agent_service.run.started");
    expect(events.at(-1)).toMatchObject({
      type: "run.cancelled",
      status: "cancelled",
      actorId: "server",
      actorType: "service",
      attributes: { reason: "server_restart" },
      parentSpanId: serviceSpan?.spanId,
    });
  });
});

/** Blocks until `cancel()` rejects the in-flight run, the way the real runners kill their child. */
class CancellableRunner extends FakeRunner {
  private rejectRun: ((error: unknown) => void) | undefined;
  override run(): Promise<RunnerResult> {
    return new Promise<RunnerResult>((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }
  override async cancel(): Promise<boolean> {
    this.rejectRun?.(new RunCancelledError());
    return true;
  }
}

describe("GlassBox control-plane adapter: cancellation and rejection", () => {
  it("records stop as cancelled with actor evidence", async () => {
    const { service, store, emitter } = await makeTraced(new CancellableRunner());
    const agent = await service.createAgent({ name: "c" });
    const { run } = await service.sendMessage(agent.id, "x");
    await new Promise((resolve) => setTimeout(resolve, 20)); // let executeRun reach the runner
    await service.stopAgent(agent.id);
    await settle(service, run.id);
    await emitter.flush();
    const events = await store.readRun(run.id);
    const cancelled = events.find((e) => e.type === "run.cancelled");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      attributes: { cancelledBy: "local-user" },
    });
    expect(typeof cancelled!.attributes["cancelRequestedAt"]).toBe("string");
    expect(new Date(String(cancelled!.attributes["cancelRequestedAt"])).toISOString()).toBe(
      cancelled!.attributes["cancelRequestedAt"],
    );
    expect(events.at(-1)).toMatchObject({
      type: "agent_service.run.failed",
      status: "cancelled",
    });
  });

  it("opens no trace when the Run is rejected", async () => {
    const { service, store, emitter } = await makeTraced(
      new (class extends FakeRunner {
        override run(): Promise<RunnerResult> {
          return new Promise(() => undefined);
        }
      })(),
    );
    const agent = await service.createAgent({ name: "busy" });
    await service.sendMessage(agent.id, "first");
    const ctx = createTraceContext({ requestId: "req-2", method: "POST" }, "metadata_only");
    await expect(service.sendMessage(agent.id, "second", ctx)).rejects.toMatchObject({
      statusCode: 409,
    });
    await emitter.flush();
    // The ingress hook ends the root span only when both are set, so a rejected POST must leave
    // them undefined — otherwise onResponse emits an http.request.completed for a Run that never was.
    expect(ctx.runId).toBeUndefined();
    expect(ctx.agentId).toBeUndefined();
    expect(store.listRuns().map((entry) => entry.traceId)).not.toContain(ctx.traceId);
  });
});
