import type { AgentService } from "../agent-service.js";
import { buildTrace } from "../glassbox/query.js";
import type { ObservationEmitter } from "../glassbox/emitter.js";
import type { TraceStore } from "../glassbox/store.js";
import { evaluateAll } from "./evaluators.js";

const terminal = new Set(["completed", "failed", "cancelled"]);

export class EvalRunner {
  constructor(private readonly service: AgentService, private readonly glassbox: { emitter: ObservationEmitter; store: TraceStore }) {}

  async execute(evalRunId: string): Promise<void> {
    const evalRun = this.service.getEvalRun(evalRunId);
    let failed = false;
    for (const caseId of evalRun.caseIds) {
      const regressionCase = this.service.getRegressionCase(caseId);
      try {
        const { run } = await this.service.runIsolated({ agentId: evalRun.target.agentId, workspaceTemplate: regressionCase.workspaceTemplate, prompt: regressionCase.prompt, tags: { evalRunId, caseId } });
        await this.waitForTerminal(run.id);
        await this.glassbox.emitter.flush();
        const view = buildTrace(await this.glassbox.store.readRun(run.id), { capturePolicy: this.glassbox.emitter.capturePolicy });
        const results = await evaluateAll(view, regressionCase.assertions);
        await this.service.updateEvalRun(evalRunId, (item) => { item.runIds.push(run.id); item.results.push({ caseId, runId: run.id, results }); });
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        await this.service.updateEvalRun(evalRunId, (item) => item.results.push({ caseId, results: [], error: message }));
      }
    }
    await this.service.updateEvalRun(evalRunId, (item) => { item.status = failed ? "failed" : "completed"; item.completedAt = new Date().toISOString(); });
  }

  private async waitForTerminal(runId: string): Promise<void> {
    for (let attempts = 0; attempts < 600; attempts++) {
      if (terminal.has(this.service.getRun(runId).status)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Eval Run timed out waiting for Run " + runId);
  }
}
