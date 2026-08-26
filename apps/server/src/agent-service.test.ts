import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { RunCancelledError } from "./errors.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { createTraceContext } from "./glassbox/context.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore, type TraceStore } from "./glassbox/store.js";

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
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
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
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const jsonStore = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
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
    const { service, store, emitter, config, jsonStore, workspaces } = await makeTraced(
      new (class extends FakeRunner {
        override run(): Promise<RunnerResult> {
          return new Promise(() => undefined);
        }
      })(),
    );
    const agent = await service.createAgent({ name: "r" });
    const { run } = await service.sendMessage(agent.id, "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await emitter.flush();
    // a second service on the same store simulates a process restart
    const restarted = new AgentService(config, jsonStore, workspaces, new FakeRunner(), emitter);
    await restarted.initialize();
    await emitter.flush();
    const events = await store.readRun(run.id);
    expect(events.at(-1)).toMatchObject({
      type: "run.cancelled",
      status: "cancelled",
      actorId: "server",
      actorType: "service",
      attributes: { reason: "server_restart" },
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
