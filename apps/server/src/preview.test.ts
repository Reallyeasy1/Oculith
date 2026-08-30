import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { AgentService } from "./agent-service.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentRunner, RunnerResult } from "./types.js";
import {
  buildPreviewContainerArgs,
  PreviewManager,
  previewContainerName,
  PREVIEW_COMMANDS,
  STATIC_SERVER_SCRIPT,
  type PreviewEngine,
} from "./preview.js";

class FakeRunner implements AgentRunner {
  async run(): Promise<RunnerResult> {
    return { output: "done", threadId: "fake-thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Records every engine invocation; per-test hooks simulate docker failures and ps listings. */
class FakeEngine implements PreviewEngine {
  calls: string[][] = [];
  onRun: ((args: string[]) => void) | undefined;
  psOutput = "";
  inspectOutput = "true\n";
  failRm: Error | undefined;
  failVersion: Error | undefined;
  failImageInspect: Error | undefined;
  async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(args);
    if (args[0] === "run") this.onRun?.(args);
    if (args[0] === "ps") return { stdout: this.psOutput, stderr: "" };
    if (args[0] === "inspect") return { stdout: this.inspectOutput, stderr: "" };
    if (args[0] === "rm" && this.failRm) throw this.failRm;
    if (args[0] === "version" && this.failVersion) throw this.failVersion;
    if (args[0] === "image" && this.failImageInspect) throw this.failImageInspect;
    return { stdout: "", stderr: "" };
  }
  runsFor(subcommand: string): string[][] {
    return this.calls.filter((call) => call[0] === subcommand);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-preview-test-"));
  temporaryDirectories.push(root);
  return root;
}

function makeConfig(root: string, env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
    ...env,
  });
}

/** #375: every start is `static` now, and start() refuses a workspace without dist/index.html —
 * lifecycle tests get a real servable workspace instead of a fake path. */
async function servableWorkspace(root: string, name: string): Promise<string> {
  const workspace = path.join(root, "workspaces", name);
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await writeFile(path.join(workspace, "dist", "index.html"), "<!doctype html>\n");
  return workspace;
}

async function makeHarness(env: Record<string, string> = {}) {
  const root = await makeRoot();
  const config = makeConfig(root, env);
  const store = new MemoryTraceStore();
  const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
  const engine = new FakeEngine();
  const previews = new PreviewManager(config, emitter, engine);
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces"), config.workspaceTemplatesDirectory),
    new FakeRunner(),
  );
  await service.initialize();
  return { root, config, store, emitter, engine, previews, service };
}

describe("preview container arguments", () => {
  it("hardens the container and never passes model credentials or the codex home", async () => {
    const { config } = await makeHarness();
    const args = buildPreviewContainerArgs({
      config,
      agentId: "agent-1",
      workspacePath: "/ws/agent-1",
      port: 5180,
      command: "static",
      previewId: "prv-1",
      traceId: "trc-1",
      spanId: "spn-1",
    });
    const joined = args.join(" ");
    expect(args).toContain("--detach");
    expect(joined).toContain("--publish 127.0.0.1:5180:5173");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--label io.codejam.launchpad=agent-preview");
    expect(joined).toContain("--label io.codejam.preview-id=prv-1");
    expect(joined).toContain("--label io.codejam.preview-trace=trc-1");
    expect(joined).toContain("--label io.codejam.preview-span=spn-1");
    expect(joined).toContain("dst=/workspace,readonly");
    // The preview serves files; it must never see model credentials or the Codex session store.
    expect(joined).not.toContain("ARK_API_KEY");
    expect(joined).not.toContain("OPENAI_API_KEY");
    expect(joined).not.toContain("codex-home");
    expect(args.slice(args.indexOf(config.containerRuntimeImage) + 1)).toEqual(PREVIEW_COMMANDS.static);
  });

  it("names preview containers by instance and agent, sanitized", () => {
    expect(previewContainerName("agent 1/x", "inst")).toBe("launchpad-preview-inst-agent-1-x");
  });
});

describe("PreviewManager lifecycle", () => {
  it("starts one preview per Agent, reports it, refuses a second, and stops it", async () => {
    const { previews, engine, emitter, store, root } = await makeHarness();
    const workspace = await servableWorkspace(root, "ws-agent-1");
    const preview = await previews.start({ id: "agent-1", workspacePath: workspace }, "static");
    expect(preview).toMatchObject({ agentId: "agent-1", command: "static", port: 5180, url: "http://localhost:5180" });
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.parse(preview.startedAt));
    expect(previews.get("agent-1")).toMatchObject({ port: 5180 });

    await expect(previews.start({ id: "agent-1", workspacePath: workspace }, "static")).rejects.toMatchObject({ statusCode: 409 });

    const stopped = await previews.stop("agent-1");
    expect(stopped?.port).toBe(5180);
    expect(previews.get("agent-1")).toBeUndefined();
    expect(engine.runsFor("rm").some((call) => call.includes(previewContainerName("agent-1", "default")))).toBe(true);

    await emitter.flush();
    const events = await store.readRun(preview.previewId);
    const started = events.find((event) => event.type === "runtime.preview.started");
    const ended = events.find((event) => event.type === "runtime.preview.stopped");
    expect(started).toMatchObject({ status: "running", phase: "start", category: "infrastructure" });
    expect(started?.attributes).toMatchObject({ port: 5180, command: "static" });
    expect(ended).toMatchObject({ status: "ok", phase: "end", spanId: started?.spanId });
    expect(ended?.attributes).toMatchObject({ reason: "user_request" });
    // The lifecycle trace is terminal once stopped, so retention can evict it (run.refused precedent).
    expect(store.listRuns().find((entry) => entry.runId === preview.previewId)?.status).toBe("ok");
  });

  it("allocates distinct ports across Agents and skips externally busy ports", async () => {
    const { previews, engine, root } = await makeHarness();
    engine.onRun = (args) => {
      if (args.join(" ").includes("127.0.0.1:5181:")) throw new Error("driver failed: port is already allocated");
    };
    await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");
    const second = await previews.start({ id: "agent-2", workspacePath: await servableWorkspace(root, "ws-2") }, "static");
    expect(second.port).toBe(5182); // 5180 in use by agent-1, 5181 busy on the host
  });

  it("refuses when every port in the range is taken", async () => {
    const { previews, root } = await makeHarness({ PREVIEW_PORT_RANGE: "5180-5181" });
    await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");
    await previews.start({ id: "agent-2", workspacePath: await servableWorkspace(root, "ws-2") }, "static");
    await expect(previews.start({ id: "agent-3", workspacePath: await servableWorkspace(root, "ws-3") }, "static")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("surfaces an engine failure as a 502 without retrying other ports", async () => {
    const { previews, engine, root } = await makeHarness();
    engine.onRun = () => {
      throw new Error("Cannot connect to the Docker daemon");
    };
    await expect(previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static")).rejects.toMatchObject({ statusCode: 502 });
    expect(engine.runsFor("run")).toHaveLength(1);
    expect(previews.get("agent-1")).toBeUndefined();
  });

  it("requires a built dist/index.html for the static command", async () => {
    const { previews, root } = await makeHarness();
    const workspace = path.join(root, "workspaces", "static-ws");
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await expect(previews.start({ id: "agent-1", workspacePath: workspace }, "static")).rejects.toMatchObject({ statusCode: 400 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(workspace, "dist", "index.html"), "<!doctype html>\n");
    const preview = await previews.start({ id: "agent-1", workspacePath: workspace }, "static");
    expect(preview.command).toBe("static");
  });

  it("stops the container when the TTL expires and records the reason", async () => {
    const { previews, engine, emitter, store, root } = await makeHarness({ PREVIEW_TTL_MS: "10000" });
    const workspace = await servableWorkspace(root, "ws-1");
    vi.useFakeTimers();
    const preview = await previews.start({ id: "agent-1", workspacePath: workspace }, "static");
    await vi.advanceTimersByTimeAsync(10_050);
    expect(previews.get("agent-1")).toBeUndefined();
    expect(engine.runsFor("rm").length).toBe(1);
    await emitter.flush();
    const ended = (await store.readRun(preview.previewId)).find((event) => event.type === "runtime.preview.stopped");
    expect(ended?.attributes).toMatchObject({ reason: "ttl_expired" });
    expect(ended?.actorId).toBe("server");
  });

  it("removes stale preview containers at boot and closes their original traces", async () => {
    const { previews, engine, emitter, store } = await makeHarness();
    engine.psOutput = [
      "launchpad-preview-default-agent-9\tagent-9\tprv-9\ttrc-9\tspn-9",
      "", // blank lines from docker are ignored
    ].join("\n");
    const removed = await previews.cleanupStale();
    expect(removed).toEqual(["launchpad-preview-default-agent-9"]);
    expect(engine.runsFor("rm").some((call) => call.includes("launchpad-preview-default-agent-9"))).toBe(true);
    await emitter.flush();
    const events = await store.readRun("prv-9");
    const ended = events.find((event) => event.type === "runtime.preview.stopped");
    expect(ended).toMatchObject({ traceId: "trc-9", spanId: "spn-9", agentId: "agent-9", status: "ok" });
    expect(ended?.attributes).toMatchObject({ reason: "stale_cleanup" });
  });

  it("refuses a second start racing the first (no engine-name-conflict 502)", async () => {
    const { previews, engine, root } = await makeHarness();
    const workspace = await servableWorkspace(root, "ws-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exec = engine.exec.bind(engine);
    engine.exec = async (args) => {
      if (args[0] === "run") await gate;
      return exec(args);
    };
    const first = previews.start({ id: "agent-1", workspacePath: workspace }, "static");
    await expect(previews.start({ id: "agent-1", workspacePath: workspace }, "static")).rejects.toMatchObject({ statusCode: 409 });
    release();
    await expect(first).resolves.toMatchObject({ port: 5180 });
  });

  it("never records a stop the engine did not confirm; the retry emits it exactly once", async () => {
    const { previews, engine, emitter, store, root } = await makeHarness();
    const preview = await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");
    engine.failRm = new Error("Cannot connect to the Docker daemon");
    await expect(previews.stop("agent-1")).rejects.toMatchObject({ statusCode: 502 });
    // Still tracked and the trace still open: the container may still be serving the port.
    expect(previews.get("agent-1")).toMatchObject({ port: 5180 });
    await emitter.flush();
    expect((await store.readRun(preview.previewId)).some((event) => event.type === "runtime.preview.stopped")).toBe(false);

    engine.failRm = undefined;
    await previews.stop("agent-1");
    await emitter.flush();
    const stops = (await store.readRun(preview.previewId)).filter((event) => event.type === "runtime.preview.stopped");
    expect(stops).toHaveLength(1);
    expect(store.listRuns().find((entry) => entry.runId === preview.previewId)?.status).toBe("ok");
  });

  it("treats 'no such container' as a confirmed removal", async () => {
    const { previews, engine, root } = await makeHarness();
    await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");
    engine.failRm = new Error("Error response from daemon: No such container: launchpad-preview-default-agent-1");
    await expect(previews.stop("agent-1")).resolves.toMatchObject({ port: 5180 });
    expect(previews.get("agent-1")).toBeUndefined();
  });

  it("status(): an unreachable engine is not an observed exit; an observed exit closes as error", async () => {
    const { previews, engine, emitter, store, root } = await makeHarness();
    const preview = await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");

    const exec = engine.exec.bind(engine);
    engine.exec = async (args) => {
      if (args[0] === "inspect") throw new Error("Cannot connect to the Docker daemon");
      return exec(args);
    };
    // Last known state, no fabricated close.
    await expect(previews.status("agent-1")).resolves.toMatchObject({ port: 5180 });
    await emitter.flush();
    expect((await store.readRun(preview.previewId)).some((event) => event.type === "runtime.preview.stopped")).toBe(false);

    engine.exec = exec;
    engine.inspectOutput = "false\n";
    await expect(previews.status("agent-1")).resolves.toBeUndefined();
    await emitter.flush();
    const ended = (await store.readRun(preview.previewId)).find((event) => event.type === "runtime.preview.stopped");
    expect(ended).toMatchObject({ status: "error" });
    expect(ended?.attributes).toMatchObject({ reason: "exited" });
    expect(store.listRuns().find((entry) => entry.runId === preview.previewId)?.status).toBe("error");
  });

  it("closes orphaned preview traces (container already gone) with an honest unset marker", async () => {
    const { previews, emitter, store } = await makeHarness();
    await previews.cleanupStale([
      { runId: "prv-orphan", traceId: "trc-orphan", agentId: "agent-9", status: "running" },
      { runId: "prv-done", traceId: "trc-done", agentId: "agent-9", status: "ok" },
      { runId: "real-run", traceId: "trc-run", agentId: "agent-9", status: "running" },
    ]);
    await emitter.flush();
    const marker = (await store.readRun("prv-orphan")).find((event) => event.type === "runtime.preview.stopped");
    expect(marker).toMatchObject({ status: "unset", phase: "instant" });
    expect(marker?.attributes).toMatchObject({ reason: "not_observed" });
    expect(store.listRuns().find((entry) => entry.runId === "prv-orphan")?.status).toBe("unset");
    expect(await store.readRun("prv-done")).toHaveLength(0);
    expect(await store.readRun("real-run")).toHaveLength(0);
  });

  it("rollupRun never summarizes a preview trace (baseline stays Runs-only)", async () => {
    const { previews, emitter, store, root } = await makeHarness();
    const preview = await previews.start({ id: "agent-1", workspacePath: await servableWorkspace(root, "ws-1") }, "static");
    await previews.stop("agent-1");
    await emitter.flush();
    const { rollupRun } = await import("./glassbox/summary.js");
    const summaries = {
      upsert: async () => { throw new Error("a preview trace must not be summarized"); },
      get: async () => undefined,
      query: async () => [],
      setTaskOutcome: async () => undefined,
    } as unknown as import("./glassbox/summary.js").RunSummaryStore;
    await expect(rollupRun({ traces: store, emitter, summaries }, preview.previewId)).resolves.toBeUndefined();
  });

  it("swallows engine failures during stale cleanup (boot must not break)", async () => {
    const { previews, engine } = await makeHarness();
    engine.exec = async () => {
      throw new Error("no docker here");
    };
    await expect(previews.cleanupStale()).resolves.toEqual([]);
  });
});

describe("preview routes", () => {
  const startedAgent = async (harness: Awaited<ReturnType<typeof makeHarness>>) => {
    const agent = await harness.service.createAgent({ name: "Previewed" });
    // #375: the only command serves dist/, so route tests build one into the agent's workspace.
    await mkdir(path.join(agent.workspacePath, "dist"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "dist", "index.html"), "<!doctype html>\n");
    return agent;
  };

  it("starts, reports and stops a preview over HTTP", async () => {
    const harness = await makeHarness();
    const app = await createApp(harness.config, harness.service, undefined, harness.previews);
    const agent = await startedAgent(harness);

    const missing = await app.inject({ method: "GET", url: "/api/agents/" + agent.id + "/preview" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ preview: null, servable: { static: true } });

    const created = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.json().preview).toMatchObject({ command: "static", port: 5180, url: "http://localhost:5180" });

    const dup = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: {} });
    expect(dup.statusCode).toBe(409);

    const fetched = await app.inject({ method: "GET", url: "/api/agents/" + agent.id + "/preview" });
    expect(fetched.json().preview).toMatchObject({ port: 5180 });

    const stopped = await app.inject({ method: "DELETE", url: "/api/agents/" + agent.id + "/preview" });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().preview).toMatchObject({ port: 5180 });
    const gone = await app.inject({ method: "DELETE", url: "/api/agents/" + agent.id + "/preview" });
    expect(gone.statusCode).toBe(404);
    await app.close();
  });

  it("validates the command and refuses when the container engine is unavailable", async () => {
    const harness = await makeHarness();
    const app = await createApp(harness.config, harness.service, undefined, harness.previews);
    const agent = await startedAgent(harness);
    const bad = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: { command: "bash" } });
    expect(bad.statusCode).toBe(400);
    // #375: vite is retired — a stale client naming it gets the same contract 400, never a container.
    const retired = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: { command: "vite" } });
    expect(retired.statusCode).toBe(400);
    await app.close();

    // #335: availability is about the engine, not the Codex provider — a broken engine is a 409
    // in any provider mode…
    const broken = await makeHarness();
    broken.engine.failVersion = new Error("Cannot connect to the Docker daemon");
    const brokenApp = await createApp(broken.config, broken.service, undefined, broken.previews);
    const brokenAgent = await broken.service.createAgent({ name: "Broken" });
    const refused = await brokenApp.inject({ method: "POST", url: "/api/agents/" + brokenAgent.id + "/preview", payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/container engine/);
    await brokenApp.close();

    // …and a healthy engine serves previews even when Codex itself runs as a local process.
    const local = await makeHarness({ RUNTIME_PROVIDER: "local-process" });
    const localApp = await createApp(local.config, local.service, undefined, local.previews);
    const localAgent = await startedAgent(local);
    const created = await localApp.inject({ method: "POST", url: "/api/agents/" + localAgent.id + "/preview", payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.json().preview).toMatchObject({ command: "static", port: 5180 });
    await localApp.close();
  });

  it("refuses to start a preview while a Run has the workspace mounted", async () => {
    const harness = await makeHarness();
    let finish!: (result: RunnerResult) => void;
    const hanging: AgentRunner = {
      run: () => new Promise((resolve) => { finish = resolve; }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      harness.config,
      new JsonStore(path.join(harness.root, "data", "db2.json")),
      new WorkspaceManager(path.join(harness.root, "workspaces"), harness.config.workspaceTemplatesDirectory),
      hanging,
    );
    await service.initialize();
    const app = await createApp(harness.config, service, undefined, harness.previews);
    const agent = await service.createAgent({ name: "Busy" });
    const receipt = await service.sendMessage(agent.id, "hold");
    const refused = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: {} });
    expect(refused.statusCode).toBe(409);
    // The background execution reaches the runner asynchronously; wait for it before releasing it.
    await expect.poll(() => typeof finish).toBe("function");
    finish({ output: "done", threadId: "t", usage: null });
    if ("run" in receipt) await service.waitForRun(receipt.run.id);
    await app.close();
  });

  it("refuses workspace reset and workspace switch while a preview is running, and stops it on delete", async () => {
    const harness = await makeHarness();
    const app = await createApp(harness.config, harness.service, undefined, harness.previews);
    const agent = await startedAgent(harness);
    await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/preview", payload: {} });

    const reset = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/workspace/reset", payload: {} });
    expect(reset.statusCode).toBe(409);
    const patched = await app.inject({ method: "PATCH", url: "/api/agents/" + agent.id, payload: { workspace: "elsewhere" } });
    expect(patched.statusCode).toBe(409);
    // A rename that keeps the workspace is fine while the preview serves it.
    const renamed = await app.inject({ method: "PATCH", url: "/api/agents/" + agent.id, payload: { name: "Renamed" } });
    expect(renamed.statusCode).toBe(200);

    const deleted = await app.inject({ method: "DELETE", url: "/api/agents/" + agent.id });
    expect(deleted.statusCode).toBe(200);
    expect(harness.previews.get(agent.id)).toBeUndefined();
    expect(harness.engine.runsFor("rm").length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("preview servability (#335, #375)", () => {
  it("reports whether the workspace has a built web dist/", async () => {
    const { previews, root } = await makeHarness();
    const workspace = path.join(root, "workspaces", "servable-ws");
    await mkdir(workspace, { recursive: true });
    await expect(previews.servable(workspace)).resolves.toEqual({ static: false });

    // A dist/ of compiled JS (a Node CLI's tsc output) is not a servable page — the static
    // server would answer "Not found" at /. Only dist/index.html makes it a site.
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await writeFile(path.join(workspace, "dist", "main.js"), "console.log(1)\n");
    await expect(previews.servable(workspace)).resolves.toEqual({ static: false });

    await writeFile(path.join(workspace, "dist", "index.html"), "<!doctype html>\n");
    await expect(previews.servable(workspace)).resolves.toEqual({ static: true });
  });

  it("does not count symlinks escaping the workspace — the container mount cannot follow them", async () => {
    const { previews, root } = await makeHarness();
    const outside = path.join(root, "outside");
    const workspace = path.join(root, "workspaces", "symlinked-ws");
    await mkdir(path.join(outside, "dist"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await writeFile(path.join(outside, "dist", "index.html"), "<!doctype html>\n");
    // The failure class seen live: content "provided" by symlinking outside the mount.
    await symlink(path.join(outside, "dist"), path.join(workspace, "dist"));
    await expect(previews.servable(workspace)).resolves.toEqual({ static: false });

    // A relative symlink staying inside the workspace still counts.
    const linkedWorkspace = path.join(root, "workspaces", "linked-ws");
    await mkdir(path.join(linkedWorkspace, "build"), { recursive: true });
    await writeFile(path.join(linkedWorkspace, "build", "index.html"), "<!doctype html>\n");
    await symlink("build", path.join(linkedWorkspace, "dist"));
    await expect(previews.servable(linkedWorkspace)).resolves.toEqual({ static: true });
  });

  it("GET /api/agents/:id/preview carries servability so the UI only offers what can serve", async () => {
    const harness = await makeHarness();
    const app = await createApp(harness.config, harness.service, undefined, harness.previews);
    const agent = await harness.service.createAgent({ name: "Fresh" });

    const fresh = await app.inject({ method: "GET", url: "/api/agents/" + agent.id + "/preview" });
    expect(fresh.json()).toEqual({ preview: null, servable: { static: false } });

    await mkdir(path.join(agent.workspacePath, "dist"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "dist", "index.html"), "<!doctype html>\n");
    const built = await app.inject({ method: "GET", url: "/api/agents/" + agent.id + "/preview" });
    expect(built.json().servable).toEqual({ static: true });
    await app.close();
  });
});

describe("static server script (#375)", () => {
  it("serves the built dist with real MIME types, SPA fallback for extension-less misses, and 404 for asset misses", async () => {
    const root = await makeRoot();
    const dist = path.join(root, "dist");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>spa</title>\n");
    await writeFile(path.join(dist, "assets", "app.js"), "console.log(1)\n");
    await writeFile(path.join(dist, "assets", "game.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));

    // The exact script the container runs; root/port env overrides exist only for this test —
    // the hardened container passes neither, keeping /workspace/dist on the fixed port.
    const child = spawn(process.execPath, ["-e", STATIC_SERVER_SCRIPT], {
      env: { PREVIEW_STATIC_ROOT: dist, PREVIEW_STATIC_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("static server never reported its port")), 5_000);
        let seen = "";
        child.stdout.on("data", (chunk: Buffer) => {
          seen += chunk.toString();
          const match = seen.match(/listening on (\d+)/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.on("exit", (code) => { clearTimeout(timer); reject(new Error("static server exited with " + code)); });
      });
      const get = (route: string) => fetch("http://127.0.0.1:" + port + route);

      const index = await get("/");
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html");
      expect(await index.text()).toContain("spa");

      const script = await get("/assets/app.js");
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript");

      // instantiateStreaming requires the real MIME type — the reason .wasm is in the table.
      const wasm = await get("/assets/game.wasm");
      expect(wasm.status).toBe(200);
      expect(wasm.headers.get("content-type")).toBe("application/wasm");

      // SPA history fallback: a client-side route survives a refresh…
      const route = await get("/scores/weekly");
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("spa");

      // …but a missing asset stays an honest 404, and traversal stays refused.
      expect((await get("/assets/missing.js")).status).toBe(404);
      expect((await get("/..%2f..%2fetc%2fpasswd")).status).toBe(403);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("preview availability (#335)", () => {
  it("probes the engine daemon and the runtime image", async () => {
    const harness = await makeHarness();
    await expect(harness.previews.isAvailable()).resolves.toBe(true);
    expect(harness.engine.calls).toContainEqual(["version"]);
    expect(harness.engine.calls).toContainEqual(["image", "inspect", harness.config.containerRuntimeImage]);
  });

  it("is unavailable when the daemon does not answer or the image is missing", async () => {
    const noDaemon = await makeHarness();
    noDaemon.engine.failVersion = new Error("Cannot connect to the Docker daemon");
    await expect(noDaemon.previews.isAvailable()).resolves.toBe(false);

    const noImage = await makeHarness();
    noImage.engine.failImageInspect = new Error("No such image: volc-agent-runtime:local");
    await expect(noImage.previews.isAvailable()).resolves.toBe(false);
  });

  it("GET /api/system reports previewAvailable from the probe, and false without a manager", async () => {
    const harness = await makeHarness({ RUNTIME_PROVIDER: "local-process" });
    const app = await createApp(harness.config, harness.service, undefined, harness.previews);
    const healthy = await app.inject({ method: "GET", url: "/api/system" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().previewAvailable).toBe(true);

    harness.engine.failVersion = new Error("daemon down");
    const broken = await app.inject({ method: "GET", url: "/api/system" });
    expect(broken.json().previewAvailable).toBe(false);
    await app.close();

    const bare = await createApp(harness.config, harness.service);
    const withoutManager = await bare.inject({ method: "GET", url: "/api/system" });
    expect(withoutManager.json().previewAvailable).toBe(false);
    await bare.close();
  });
});
