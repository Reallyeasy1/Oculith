import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildPostCheckContainerArgs, PostCheckRunner } from "./postcheck-runner.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

const config = () => loadConfig({ NODE_ENV: "test", MODEL_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });

describe("PostCheckRunner", () => {
  it("runs pass/fail checks locally and records only bounded metadata", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "postcheck-"));
    await writeFile(path.join(workspace, "run"), "process.stderr.write('token=secret-value'); process.exit(1)");
    const store = new MemoryTraceStore();
    await store.initialize();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const runner = new PostCheckRunner({ ...config(), runtimeProvider: "container", containerEngine: process.execPath }, emitter);
    const result = await runner.run({
      workspacePath: workspace,
      command: "node --test",
      timeoutMs: 5_000,
      trace: { traceId: "trc-1", runId: "run-1", agentId: "agent-1", parentSpanId: "spn-parent" },
    });
    await emitter.flush();
    expect(result.exitCode).toBe(1);
    expect(result.stderrBytes).toBeGreaterThan(0);
    const events = await store.readRun("run-1");
    expect(events.map((event) => event.type)).toEqual(["runtime.postcheck.started", "runtime.postcheck.failed"]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("container arguments retain hardening but exclude model credentials and Codex home", () => {
    const cfg = { ...config(), runtimeProvider: "container" as const };
    const args = buildPostCheckContainerArgs({ workspacePath: "/tmp/work", command: "node --test", timeoutMs: 1_000 }, cfg, "check-1");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("type=bind,src=/tmp/work,dst=/workspace");
    expect(args).not.toContain("ARK_API_KEY");
    expect(args).not.toContain("OPENAI_API_KEY");
    expect(args.join(" ")).not.toContain("codex-home");
    expect(args.slice(-3)).toEqual(["bash", "-lc", "node --test"]);
  });
});
