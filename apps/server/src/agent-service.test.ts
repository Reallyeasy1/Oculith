import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, configHash, configSnapshot, serverHeartbeatPath } from "./agent-service.js";
import { EvalRunner } from "./eval/runner.js";
import { RunCancelledError } from "./errors.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentConfigSnapshot, AgentRunner, RunActivity, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { createTraceContext } from "./glassbox/context.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore, type TraceStore } from "./glassbox/store.js";
import { JsonEvaluationStore } from "./glassbox/evaluation.js";
import { JsonRunSummaryStore, scheduleRollup } from "./glassbox/summary.js";
import { RunLogStore } from "./run-log-store.js";

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

  it("surfaces live runner activity on the polled Run and clears it on terminal states", async () => {
    let report!: (activity: RunActivity | null) => void;
    let finish!: (result: RunnerResult) => void;
    let fail!: (error: Error) => void;
    const runner: AgentRunner = {
      run: (request: RunnerRequest) =>
        new Promise((resolve, reject) => {
          report = (activity) => request.onActivity?.(activity);
          finish = resolve;
          fail = reject;
        }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Live" });

    const first = (await service.sendMessage(agent.id, "multi-step task")).run;
    expect(service.getRun(first.id).currentActivity).toBeUndefined();
    await expect.poll(() => service.getRun(first.id).status).toBe("running");
    report({ kind: "command", label: "Running npm…" });
    await expect.poll(() => service.getRun(first.id).currentActivity?.label).toBe("Running npm…");
    report({ kind: "thinking", label: "Thinking…" });
    await expect.poll(() => service.getRun(first.id).currentActivity?.kind).toBe("thinking");
    report(null);
    await expect.poll(() => service.getRun(first.id).currentActivity).toBeUndefined();
    report({ kind: "thinking", label: "Thinking…" });
    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(first.id).status).toBe("completed");
    expect(service.getRun(first.id).currentActivity).toBeUndefined();

    const second = (await service.sendMessage(agent.id, "and fail")).run;
    await expect.poll(() => service.getRun(second.id).status).toBe("running");
    report({ kind: "command", label: "Running npm…" });
    await expect.poll(() => service.getRun(second.id).currentActivity?.label).toBe("Running npm…");
    fail(new Error("runner exploded"));
    await expect.poll(() => service.getRun(second.id).status).toBe("failed");
    expect(service.getRun(second.id).currentActivity).toBeUndefined();
  });

  it("coalesces a synchronous burst of activity updates into at most two store writes", async () => {
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
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const rawMutate = store.mutate.bind(store);
    let counting = false;
    let writes = 0;
    store.mutate = ((mutation: never) => {
      if (counting) writes += 1;
      return rawMutate(mutation);
    }) as typeof store.mutate;
    let report!: (activity: RunActivity | null) => void;
    let finish!: (result: RunnerResult) => void;
    const runner: AgentRunner = {
      run: (request: RunnerRequest) =>
        new Promise((resolve) => {
          report = (activity) => request.onActivity?.(activity);
          finish = resolve;
        }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory),
      runner,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Burst" });
    const { run } = await service.sendMessage(agent.id, "spam activities");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");
    // Let the run-start bookkeeping writes drain so only activity writes are counted below.
    await rawMutate(() => undefined);
    counting = true;
    for (let index = 1; index <= 5; index += 1) {
      report({ kind: "command", label: "Running step" + index + "…" });
    }
    await expect.poll(() => service.getRun(run.id).currentActivity?.label).toBe("Running step5…");
    counting = false;
    expect(writes).toBeLessThanOrEqual(2);
    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
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

async function makeTraced(runner: AgentRunner = new FakeRunner(), store: TraceStore = new MemoryTraceStore(), capturePolicy: "metadata_only" | "safe_summary" = "metadata_only") {
  const emitter = new ObservationEmitter({ store, capturePolicy });
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
  const runLogs = new RunLogStore(path.join(root, "data", "logs"), 1_000_000);
  await runLogs.initialize();
  const service = new AgentService(config, jsonStore, workspaces, runner, emitter, undefined, runLogs);
  await service.initialize();
  return { service, store, emitter, config, jsonStore, workspaces, runLogs };
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
    const regressionCase = await service.createRegressionCase({ name: "case", prompt: "do it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }, { type: "expected_tool", program: "git" }, { type: "expected_tool", program: "npm" }] });
    expect(regressionCase.templateHash).toMatch(/^[0-9a-f]{64}$/);
    const evalRun = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } });
    expect(evalRun).toMatchObject({ templateHashes: { fixture: regressionCase.templateHash } });
    expect(evalRun.templateHashMismatch).toBeUndefined();
    await new EvalRunner(service, { emitter, store, summaries, evaluations }).execute(evalRun.id);
    const finished = service.getEvalRun(evalRun.id);
    expect(finished).toMatchObject({ status: "completed", runIds: [expect.any(String)] });
    expect(finished.results[0]).toMatchObject({ caseId: regressionCase.id, runId: finished.runIds[0], results: expect.arrayContaining([expect.objectContaining({ type: "terminal_status", pass: true })]) });
    // One result per (run, evaluator, version): the two expected_tool assertions fold into one failed verdict (FakeRunner calls no tool).
    expect((await evaluations.resultsForRun(finished.runIds[0]!)).map(({ evaluatorId, evaluatorVersion, passed, jobId, metadata }) => ({ evaluatorId, evaluatorVersion, passed, jobId, metadata })).sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId))).toEqual([
      { evaluatorId: "expected_tool", evaluatorVersion: 1, passed: false, jobId: evalRun.id, metadata: { assertions: 2 } },
      { evaluatorId: "terminal_status", evaluatorVersion: 1, passed: true, jobId: evalRun.id, metadata: { expected: "ok", observed: "ok" } },
    ]);
    // FR-22: the failed expected_tool assertions mark the task failed, attributed to this EvalRun.
    expect(await summaries.get(finished.runIds[0]!)).toMatchObject({ taskOutcome: "failed", taskOutcomeSource: `deterministic:${evalRun.id}` });
    await emitter.flush();
    expect((await store.readRun(finished.runIds[0]!)).find((event) => event.type === "run.created")?.attributes).toMatchObject({ evalRunId: evalRun.id, caseId: regressionCase.id, templateHash: regressionCase.templateHash });
    // A case whose deterministic assertions all pass marks the task passed.
    const passingCase = await service.createRegressionCase({ name: "passing", prompt: "do it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }] });
    const passingEvalRun = await service.createEvalRun({ caseIds: [passingCase.id], target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } });
    await new EvalRunner(service, { emitter, store, summaries, evaluations }).execute(passingEvalRun.id);
    expect(await summaries.get(service.getEvalRun(passingEvalRun.id).runIds[0]!)).toMatchObject({ taskOutcome: "passed", taskOutcomeSource: `deterministic:${passingEvalRun.id}` });
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
      finalMessageBytes: 16,
      reportedFailure: false,
    });
    expect(JSON.stringify(events)).not.toContain("hello"); // prompt text is never stored
  });

  it("persists only outcome metadata under metadata_only and a redacted bounded summary under safe_summary", async () => {
    const secret = "ark-12345678-1234-1234-1234-123456789abc";
    const runner = new (class extends FakeRunner {
      override async run(): Promise<RunnerResult> {
        return { output: `Unable to continue with ${secret}`, threadId: "thread", usage: null };
      }
    })();
    const metadata = await makeTraced(runner);
    const metadataAgent = await metadata.service.createAgent({ name: "metadata outcome" });
    const metadataRun = (await metadata.service.sendMessage(metadataAgent.id, "go")).run;
    await settle(metadata.service, metadataRun.id); await metadata.emitter.flush();
    const metadataEvent = (await metadata.store.readRun(metadataRun.id)).find((event) => event.type === "run.completed")!;
    expect(metadataEvent.attributes).toMatchObject({ reportedFailure: true, finalMessageBytes: expect.any(Number) });
    expect(metadataEvent.summary).toBeUndefined();
    expect(JSON.stringify(metadataEvent)).not.toContain(secret);

    const safe = await makeTraced(runner, new MemoryTraceStore(), "safe_summary");
    const safeAgent = await safe.service.createAgent({ name: "safe outcome" });
    const safeRun = (await safe.service.sendMessage(safeAgent.id, "go")).run;
    await settle(safe.service, safeRun.id); await safe.emitter.flush();
    const safeEvent = (await safe.store.readRun(safeRun.id)).find((event) => event.type === "run.completed")!;
    expect(safeEvent.summary?.text).toContain("[REDACTED:ark_key]");
    expect(JSON.stringify(safeEvent)).not.toContain(secret);
  });

  it("redacts a runner failure before it reaches the process logger (#75)", async () => {
    const secret = "ark-12345678-1234-1234-1234-123456789abc";
    const { service } = await makeTraced(new (class extends FakeRunner {
      override async run(): Promise<RunnerResult> { throw new Error("boom " + secret); }
    })());
    const lines: string[] = [];
    service.setLogger({ child: () => ({ info: (message) => { lines.push(message); }, error: (detail, message) => { lines.push(JSON.stringify(detail) + " " + message); } }) });
    const agent = await service.createAgent({ name: "leaky" });
    const run = (await service.sendMessage(agent.id, "go")).run;
    expect((await settle(service, run.id)).status).toBe("failed");
    expect(lines.join("\n")).toContain("Runner failed");
    expect(lines.join("\n")).toContain("[REDACTED:ark_key]");
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("redacts stream-derived label text on the pino sibling of run-log lines (#232 privacy review)", async () => {
    // argument0 can be a `NAME=value` first token of a model-authored command: the uppercase form is
    // caught by env_assignment, the lowercase form only by LOG_SECRET_ASSIGNMENT — pin both surfaces.
    const upper = "MY_TOKEN=sk-proj-abcdefghij1234567890abc";
    const lower = "token=lowercase-secret-000000";
    const { service, runLogs } = await makeTraced(new (class extends FakeRunner {
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        request.logger?.warn?.("Sandbox declined shell:bash " + upper);
        request.logger?.error("Tool failed shell:bash " + lower + " (exit code 1)");
        return super.run(request);
      }
    })());
    const pinoLines: string[] = [];
    service.setLogger({ child: () => ({
      info: (message) => { pinoLines.push(message); },
      warn: (message) => { pinoLines.push(message); },
      error: (detail, message) => { pinoLines.push(JSON.stringify(detail) + " " + message); },
    }) });
    const agent = await service.createAgent({ name: "denied" });
    const { run } = await service.sendMessage(agent.id, "go");
    await settle(service, run.id);
    await runLogs.flush();
    const pino = pinoLines.join("\n");
    expect(pino).toContain("Sandbox declined shell:bash");
    expect(pino).toContain("Tool failed shell:bash");
    expect(pino).not.toContain(upper);
    expect(pino).not.toContain(lower);
    const stored = JSON.stringify((await runLogs.readRun(run.id, { limit: 100 })).lines);
    expect(stored).not.toContain(upper);
    expect(stored).not.toContain(lower);
  });

  it("writes a per-Run log story: start, workspace summary, completion summary with runner stats (#232)", async () => {
    const { service, runLogs } = await makeTraced(new (class extends FakeRunner {
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "artifact.txt"), "secret file contents", "utf8");
        return {
          output: "Completed: " + request.prompt,
          threadId: "fake-thread",
          usage: { inputTokens: 1234, outputTokens: 56 },
          stats: { modelCalls: 20, toolCalls: 38, toolFailures: 2, sandboxDenials: 25 },
        };
      }
    })());
    const agent = await service.createAgent({ name: "logged" });
    const { run } = await service.sendMessage(agent.id, "please use token=super-secret-prompt");
    await settle(service, run.id);
    await runLogs.flush();

    const { lines } = await runLogs.readRun(run.id, { limit: 100 });
    const messages = lines.map((line) => line.msg);
    expect(messages).toContain("Run started");
    expect(messages).toContain("Workspace changed: 1 added, 0 modified, 0 removed");
    expect(messages.find((message) => message.startsWith("Run completed"))).toMatch(
      /^Run completed: status=completed duration=\d+s modelCalls=20 toolCalls=38 toolFailures=2 sandboxDenials=25 tokensIn=1234 tokensOut=56$/,
    );
    // No raw content on any line: not the prompt, not workspace file contents (invariants 1/5).
    const joined = JSON.stringify(lines);
    expect(joined).not.toContain("super-secret-prompt");
    expect(joined).not.toContain("secret file contents");
  });

  it("omits runner stats from the completion summary when the runner reported none", async () => {
    const { service, runLogs } = await makeTraced();
    const agent = await service.createAgent({ name: "statless" });
    const { run } = await service.sendMessage(agent.id, "go");
    await settle(service, run.id);
    await runLogs.flush();
    const { lines } = await runLogs.readRun(run.id, { limit: 100 });
    expect(lines.map((line) => line.msg).find((message) => message.startsWith("Run completed"))).toMatch(
      /^Run completed: status=completed duration=\d+s tokensIn=12 tokensOut=5$/,
    );
  });

  it("logs a cancel with its duration at error level (#232)", async () => {
    const { service, runLogs } = await makeTraced(new (class extends FakeRunner {
      override async run(): Promise<RunnerResult> { throw new RunCancelledError(); }
    })());
    const agent = await service.createAgent({ name: "cancelled" });
    const { run } = await service.sendMessage(agent.id, "go");
    expect((await settle(service, run.id)).status).toBe("cancelled");
    await runLogs.flush();
    const { lines } = await runLogs.readRun(run.id, { level: "error", limit: 100 });
    expect(lines.map((line) => line.msg).find((message) => message.startsWith("Run cancelled"))).toMatch(/^Run cancelled after \d+s$/);
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
    const lastSeenAt = "2026-08-28T10:00:00.000Z";
    await writeFile(serverHeartbeatPath(config.dataDirectory), JSON.stringify({ lastSeenAt }));
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
      attributes: { reason: "server_restart", lastSeenAt },
      parentSpanId: serviceSpan?.spanId,
    });
  });
});

/** Blocks until `cancel()` rejects the in-flight run, the way the real runners kill their child. */
class CancellableRunner extends FakeRunner {
  private rejectRun: ((error: unknown) => void) | undefined;
  private markReached: (() => void) | undefined;
  /** Resolves once `run()` was invoked — cancelling before that finds nothing to reject and hangs the test. */
  readonly reached = new Promise<void>((resolve) => { this.markReached = resolve; });
  override run(): Promise<RunnerResult> {
    this.markReached?.();
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
    const runner = new CancellableRunner();
    const { service, store, emitter } = await makeTraced(runner);
    const agent = await service.createAgent({ name: "c" });
    const { run } = await service.sendMessage(agent.id, "x");
    await runner.reached; // a fixed sleep raced executeRun under full-suite load: cancel before run() hangs
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

/**
 * #253 post-run verification. Cross-platform trick borrowed from postcheck-runner.test.ts: with
 * RUNTIME_PROVIDER=container and CONTAINER_ENGINE=node, the PostCheckRunner spawns
 * `node run --rm ...` in the workspace, i.e. it executes the workspace file named `run` — so a
 * `run` file that exits 0/1 stands in for the verify command without needing bash or docker.
 */
describe("post-run verification (#253)", () => {
  async function makeVerifying(engine: string = process.execPath) {
    const store = new MemoryTraceStore();
    await store.initialize();
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
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: engine,
    });
    const jsonStore = new JsonStore(path.join(root, "data", "db.json"));
    const summaries = new JsonRunSummaryStore(jsonStore);
    const runLogs = new RunLogStore(path.join(root, "data", "logs"), 1_000_000);
    await runLogs.initialize();
    const rollup = { traces: store, emitter, summaries };
    // Mirrors the index.ts wiring: the verify verdict rides the rollup, off the Run's path.
    const service = new AgentService(
      config,
      jsonStore,
      new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory),
      new FakeRunner(),
      emitter,
      (runId, verify) => void scheduleRollup(rollup, runId, verify),
      runLogs,
    );
    await service.initialize();
    return { service, store, emitter, summaries, config, runLogs };
  }

  it("stamps taskOutcome passed via post_check and traces the check when the command exits 0", async () => {
    const { service, store, emitter, summaries } = await makeVerifying();
    const agent = await service.createAgent({ name: "verified", verifyCommand: 'node -e "process.exit(0)"' });
    await writeFile(path.join(agent.workspacePath, "run"), "process.exit(0)", "utf8");
    const { run } = await service.sendMessage(agent.id, "do the task");
    expect((await settle(service, run.id)).status).toBe("completed");
    await expect.poll(async () => (await summaries.get(run.id))?.taskOutcome).toBe("passed");
    expect(await summaries.get(run.id)).toMatchObject({ taskOutcome: "passed", taskOutcomeSource: "post_check", executionStatus: "completed" });
    await emitter.flush();
    const types = (await store.readRun(run.id)).map((event) => event.type);
    expect(types).toContain("runtime.postcheck.started");
    expect(types).toContain("runtime.postcheck.completed");
    // the verify is evidence inside the Run's trace, before its terminal event
    expect(types.indexOf("runtime.postcheck.completed")).toBeLessThan(types.indexOf("run.completed"));
    // The command text itself is never evidence: not in any stored event (privacy review pin).
    expect(JSON.stringify(await store.readRun(run.id))).not.toContain('process.exit(0)');
  });

  it("stamps taskOutcome failed when the command exits non-zero and never changes the Run status", async () => {
    const { service, store, emitter, summaries } = await makeVerifying();
    const agent = await service.createAgent({ name: "failing", verifyCommand: 'node -e "process.exit(1)"' });
    await writeFile(path.join(agent.workspacePath, "run"), "process.exit(1)", "utf8");
    const { run } = await service.sendMessage(agent.id, "do the task");
    expect((await settle(service, run.id)).status).toBe("completed");
    await expect.poll(async () => (await summaries.get(run.id))?.taskOutcome).toBe("failed");
    expect(await summaries.get(run.id)).toMatchObject({ taskOutcome: "failed", taskOutcomeSource: "post_check", executionStatus: "completed" });
    expect(service.getRun(run.id).status).toBe("completed");
    await emitter.flush();
    expect((await store.readRun(run.id)).map((event) => event.type)).toContain("runtime.postcheck.failed");
  });

  it("keeps the phrase-heuristic fallback when no verifyCommand is set", async () => {
    const { service, store, emitter, summaries } = await makeVerifying();
    const agent = await service.createAgent({ name: "plain" });
    const { run } = await service.sendMessage(agent.id, "do the task");
    expect((await settle(service, run.id)).status).toBe("completed");
    await expect.poll(async () => (await summaries.get(run.id))?.executionStatus).toBe("completed");
    expect(await summaries.get(run.id)).toMatchObject({ taskOutcome: "unknown" });
    expect((await summaries.get(run.id))?.taskOutcomeSource).toBeUndefined();
    await emitter.flush();
    expect((await store.readRun(run.id)).map((event) => event.type)).not.toContain("runtime.postcheck.started");
  });

  it("leaves the Run completed and the outcome unknown when the verify machinery itself crashes", async () => {
    const { service, summaries, runLogs } = await makeVerifying(path.join(tmpdir(), "definitely-missing-engine"));
    const agent = await service.createAgent({ name: "crashy", verifyCommand: 'node -e "process.exit(0)"' });
    const { run } = await service.sendMessage(agent.id, "do the task");
    expect((await settle(service, run.id)).status).toBe("completed");
    await expect.poll(async () => (await summaries.get(run.id))?.executionStatus).toBe("completed");
    expect(await summaries.get(run.id)).toMatchObject({ taskOutcome: "unknown" });
    await runLogs.flush();
    const { lines } = await runLogs.readRun(run.id, { level: "error", limit: 100 });
    expect(lines.map((line) => line.msg)).toContain("Verify command failed to run");
  });

  it("does not run the verify for eval-isolated Runs — their own post_check machinery owns the verdict", async () => {
    const { service, store, emitter, config } = await makeVerifying();
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    const agent = await service.createAgent({ name: "eval target", verifyCommand: 'node -e "process.exit(0)"' });
    const { run } = await service.runIsolated({ agentId: agent.id, workspaceTemplate: "fixture", prompt: "evaluate" });
    expect((await settle(service, run.id)).status).toBe("completed");
    await emitter.flush();
    expect((await store.readRun(run.id)).map((event) => event.type)).not.toContain("runtime.postcheck.started");
  });

  it("changes the configHash when verifyCommand changes and never snapshots the raw command", async () => {
    const { service, config } = await makeVerifying();
    const agent = await service.createAgent({ name: "hashed", verifyCommand: '  node -e "process.exit(0)"  ' });
    expect(agent.verifyCommand).toBe('node -e "process.exit(0)"');
    const base = configHash(configSnapshot(agent, config));
    const updated = await service.updateAgent(agent.id, { verifyCommand: "npm test" });
    expect(updated.verifyCommand).toBe("npm test");
    expect(configHash(configSnapshot(updated, config))).not.toBe(base);
    expect(JSON.stringify(configSnapshot(updated, config))).not.toContain("npm test");
    expect(configSnapshot(updated, config).verifyCommand).toMatch(/^sha256:[0-9a-f]{64}$/);
    const cleared = await service.updateAgent(agent.id, { verifyCommand: "" });
    expect(cleared.verifyCommand).toBeUndefined();
    expect(configSnapshot(cleared, config).verifyCommand).toBeUndefined();
    expect(configHash(configSnapshot(cleared, config))).not.toBe(configHash(configSnapshot(updated, config)));
  });
});
