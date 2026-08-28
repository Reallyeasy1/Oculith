import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, configHash, configSnapshot } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { ObservationEmitter } from "../glassbox/emitter.js";
import { newId } from "../glassbox/schema.js";
import { MemoryTraceStore } from "../glassbox/store.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { compareEvalRuns } from "./compare.js";
import { EvalRunner } from "./runner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FixtureRunner implements AgentRunner {
  constructor(private readonly emitter: ObservationEmitter) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const instructions = await readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8");
    if (!instructions.includes("REGRESSION")) {
      await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "fixed.js"), "export const fixed = true;\n");
      this.emitter.emit({ ...request.trace!, spanId: newId("spn"), type: "tool.call.completed", category: "tool", name: "shell:node", status: "ok", source: { component: "FixtureRunner", observed: true }, attributes: { program: "node" } });
    }
    return { output: "fixture complete", threadId: null, usage: null };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("regression workflow integration", () => {
  it("detects an instruction-driven candidate regression with resolvable evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eval-integration-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" });
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(config.workspaceRoot, config.workspaceTemplatesDirectory), new FixtureRunner(emitter), emitter);
    await service.initialize();
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    const agent = await service.createAgent({ name: "Regression target", template: "fixture", instructions: "Fix the fixture." });
    const regressionCase = await service.createRegressionCase({ name: "fixes fixture", prompt: "fix it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "terminal_status", expected: "ok" }, { type: "expected_tool", program: "node" }] });
    const baseline = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot: configSnapshot(agent, config), configHash: configHash(configSnapshot(agent, config)) } });
    await new EvalRunner(service, { emitter, store }, config).execute(baseline.id);
    await service.updateAgent(agent.id, { instructions: "REGRESSION: skip the fix." });
    const candidateAgent = service.getAgent(agent.id);
    const candidate = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot: configSnapshot(candidateAgent, config), configHash: configHash(configSnapshot(candidateAgent, config)) } });
    await new EvalRunner(service, { emitter, store }, config).execute(candidate.id);
    const before = service.getEvalRun(baseline.id), after = service.getEvalRun(candidate.id);
    const comparison = compareEvalRuns(before, after);
    expect(before.results[0]?.results.every((result) => result.pass)).toBe(true);
    expect(after.results[0]?.results.find((result) => result.type === "expected_tool")?.pass).toBe(false);
    expect(comparison.regressions).toBeGreaterThanOrEqual(1);
    expect(after.target.configHash).not.toBe(before.target.configHash);
    const candidateRun = service.getRun(after.runIds[0]!);
    expect(candidateRun.id).toBe(after.runIds[0]);
    expect(candidateRun.status).toBe("completed");
    await emitter.flush();
    const evidence = after.results[0]?.results.find((result) => result.type === "terminal_status")?.evidenceEventIds[0];
    expect((await store.readRun(after.runIds[0]!)).some((event) => event.eventId === evidence)).toBe(true);
  });
});

/**
 * #282: post_check assertions in real EvalRuns. Cross-platform trick from postcheck-runner.test.ts:
 * with RUNTIME_PROVIDER=container and CONTAINER_ENGINE=node, the PostCheckRunner spawns
 * `node run --rm ...` with cwd = the eval workspace, i.e. it executes the workspace file named
 * `run` — which the fixture runner writes during the Run. The check succeeding is therefore also
 * the proof that the workspace still exists at evaluation time.
 */
describe("post_check assertions in EvalRuns (#282)", () => {
  async function makeHarness(runExitCode: number, environment: Record<string, string> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "eval-postcheck-")); roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      WORKSPACE_TEMPLATES_DIR: path.join(root, "templates"), CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key", ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container", CONTAINER_ENGINE: process.execPath,
      GLASSBOX_POSTCHECK_ALLOWLIST: "node --test", ...environment,
    });
    const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const runner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "run"), `process.exit(${runExitCode})`, "utf8");
        return { output: "fixture complete", threadId: null, usage: null };
      },
      async cancel() { return false; },
      async isAvailable() { return true; },
    };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(config.workspaceRoot, config.workspaceTemplatesDirectory), runner, emitter);
    await service.initialize();
    await mkdir(path.join(config.workspaceTemplatesDirectory, "fixture"), { recursive: true });
    const agent = await service.createAgent({ name: "Post-check target", template: "fixture", instructions: "Fix it." });
    return { config, store, emitter, service, agent };
  }

  async function executeCase(harness: Awaited<ReturnType<typeof makeHarness>>, command: string) {
    const { config, store, emitter, service, agent } = harness;
    const regressionCase = await service.createRegressionCase({ name: "post-check case", prompt: "fix it", workspaceTemplate: "fixture", baselineConfigHash: "baseline", assertions: [{ type: "post_check", command, timeoutMs: 10_000 }] });
    const evalRun = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot: configSnapshot(agent, config), configHash: configHash(configSnapshot(agent, config)) } });
    await new EvalRunner(service, { emitter, store }, config).execute(evalRun.id);
    return service.getEvalRun(evalRun.id);
  }

  it("passes an allow-listed post_check that exits 0 and traces it in the same run", async () => {
    const harness = await makeHarness(0);
    const finished = await executeCase(harness, "node --test");
    const result = finished.results[0]?.results.find((item) => item.type === "post_check");
    expect(result).toMatchObject({ pass: true, observed: 0, message: "Post-check exited 0." });
    await harness.emitter.flush();
    const events = await harness.store.readRun(finished.runIds[0]!);
    const types = events.map((event) => event.type);
    expect(types).toContain("runtime.postcheck.started");
    expect(types).toContain("runtime.postcheck.completed");
    // Evidence resolves to the postcheck events inside the eval Run's own trace.
    expect(result!.evidenceEventIds.length).toBeGreaterThan(0);
    for (const eventId of result!.evidenceEventIds) expect(events.some((event) => event.eventId === eventId)).toBe(true);
    // Cleanup was deferred past evaluation, not skipped: the workspace is gone once execute returns.
    expect(existsSync(path.join(harness.config.workspaceRoot, ".eval", finished.runIds[0]!))).toBe(false);
  });

  it("fails an allow-listed post_check that exits 1", async () => {
    const harness = await makeHarness(1);
    const finished = await executeCase(harness, "node --test");
    // An assertion miss is a case verdict, not an EvalRun infrastructure failure.
    expect(finished.status).toBe("completed");
    const result = finished.results[0]?.results.find((item) => item.type === "post_check");
    expect(result).toMatchObject({ pass: false, observed: 1, message: "Post-check exited 1." });
    await harness.emitter.flush();
    expect((await harness.store.readRun(finished.runIds[0]!)).map((event) => event.type)).toContain("runtime.postcheck.failed");
  });

  it("fails closed without running a command that is not allow-listed", async () => {
    const harness = await makeHarness(0);
    const finished = await executeCase(harness, "node --evil");
    const result = finished.results[0]?.results.find((item) => item.type === "post_check");
    expect(result).toMatchObject({ pass: false, observed: null, message: "Post-check command is not allow-listed for this workspace template." });
    await harness.emitter.flush();
    expect((await harness.store.readRun(finished.runIds[0]!)).map((event) => event.type)).not.toContain("runtime.postcheck.started");
  });

  it("keeps the eval workspace when KEEP_EVAL_WORKSPACES=1", async () => {
    const harness = await makeHarness(0, { KEEP_EVAL_WORKSPACES: "1" });
    const finished = await executeCase(harness, "node --test");
    expect(finished.results[0]?.results.find((item) => item.type === "post_check")?.pass).toBe(true);
    expect(existsSync(path.join(harness.config.workspaceRoot, ".eval", finished.runIds[0]!))).toBe(true);
  });
});
