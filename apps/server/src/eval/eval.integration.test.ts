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
    await new EvalRunner(service, { emitter, store }).execute(baseline.id);
    await service.updateAgent(agent.id, { instructions: "REGRESSION: skip the fix." });
    const candidateAgent = service.getAgent(agent.id);
    const candidate = await service.createEvalRun({ caseIds: [regressionCase.id], target: { agentId: agent.id, snapshot: configSnapshot(candidateAgent, config), configHash: configHash(configSnapshot(candidateAgent, config)) } });
    await new EvalRunner(service, { emitter, store }).execute(candidate.id);
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
