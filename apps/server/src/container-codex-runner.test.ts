import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  ContainerCodexRunner,
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";
import { RunCancelledError } from "./errors.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("records the real cleanup path: `signal` when `rm --force` fails, never a claimed removal", async () => {
    // No module mocks: the engine is node itself, so `run ...` executes a script named `run` in the
    // workspace cwd, and `rm --force <name>` (no such script in the server cwd) fails like an engine
    // that could not remove the container — the fallback is to signal the client process.
    const dir = await mkdtemp(path.join(tmpdir(), "container-runner-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "run"), 'process.stdout.write("x"); setTimeout(() => {}, 10_000);');
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: dir,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: process.execPath,
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runner = new ContainerCodexRunner(config, emitter);
    const trace = { traceId: "trc_1", runId: "run-1", agentId: "agt-1", parentSpanId: "spn_svc" };
    const pending = runner.run({ agentId: "agt-1", workspacePath: dir, prompt: "p", threadId: null, trace });
    // Cancellation is intentionally exercised after output reaches the observer. Without this
    // synchronization the test races process startup: a fast CI worker can terminate the child
    // before stdout is delivered, making the unrelated first-output assertion intermittent.
    await expect.poll(async () =>
      (await store.readRun("run-1")).filter((event) => event.type === "runtime.codex.first_output").length,
    ).toBe(1);
    expect(await runner.cancel("agt-1")).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
    await emitter.flush();
    const events = await store.readRun("run-1");
    const stopped = events.find((e) => e.type === "runtime.container.stopped");
    expect(stopped).toMatchObject({ status: "cancelled", attributes: { cleanup: "signal" } });
    expect(stopped!.attributes).not.toHaveProperty("removed");
    // #54: container.stopped carries only the container outcome (status/exitCode/cleanup);
    // the codex span's error stays on the codex span.
    expect(stopped!.error).toBeUndefined();
    expect(events.find((e) => e.type === "runtime.codex.failed")!.error).toMatchObject({ type: "cancelled" });
    const firstOutput = events.filter((e) => e.type === "runtime.codex.first_output");
    expect(firstOutput).toHaveLength(1);
    expect(firstOutput[0]).toMatchObject({ phase: "instant", parentSpanId: expect.any(String), attributes: { latencyMs: expect.any(Number) } });
  }, 30_000);

  it("#243: stamps echo-verified `resumed` on the span end and logs the resume once, with no runner-side failure line", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "container-runner-"));
    dirs.push(dir);
    const stream = [
      { type: "thread.started", thread_id: "thread-123" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await writeFile(
      path.join(dir, "run"),
      "for (const line of " + JSON.stringify(stream.map((l) => JSON.stringify(l))) + ") process.stdout.write(line + '\\n');",
    );
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: dir,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: process.execPath,
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runner = new ContainerCodexRunner(config, emitter);
    const trace = { traceId: "trc_1", runId: "run-1", agentId: "agt-1", parentSpanId: "spn_svc" };
    const logged: string[] = [];
    const logger = {
      info: (message: string) => logged.push("info " + message),
      warn: (message: string) => logged.push("warn " + message),
      error: (message: string) => logged.push("error " + message),
    };
    // Codex echoed the exact thread id it was asked to resume: the trace records resumed=true and the
    // log line may honestly say "resumed".
    const result = await runner.run({ agentId: "agt-1", workspacePath: dir, prompt: "p", threadId: "thread-123", trace, logger });
    expect(result.output).toBe("done");
    await emitter.flush();
    const end = (await store.readRun("run-1")).find((e) => e.type === "runtime.codex.completed")!;
    expect(end.attributes.resumed).toBe(true);
    expect(end.attributes.sessionId).toBe("thread-123");
    expect(logged).toContain("info Codex session resumed");
    expect(logged.filter((line) => line.startsWith("error"))).toEqual([]);
  }, 30_000);

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-4)).toEqual(["resume", "thread-123", "--", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
