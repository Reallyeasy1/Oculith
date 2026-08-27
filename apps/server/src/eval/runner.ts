import type { AgentService } from "../agent-service.js";
import { buildTrace } from "../glassbox/query.js";
import type { ObservationEmitter } from "../glassbox/emitter.js";
import type { TraceStore } from "../glassbox/store.js";
import type { EvaluationStore } from "../glassbox/evaluation.js";
import { rollupRun, type RunSummaryStore } from "../glassbox/summary.js";
import { evaluateAll } from "./evaluators.js";

export class EvalRunner {
  constructor(private readonly service: AgentService, private readonly glassbox: { emitter: ObservationEmitter; store: TraceStore; summaries?: RunSummaryStore | undefined; evaluations?: EvaluationStore | undefined }) {}

  async execute(evalRunId: string): Promise<void> {
    const evalRun = this.service.getEvalRun(evalRunId);
    let failed = false;
    for (const caseId of evalRun.caseIds) {
      const regressionCase = this.service.getRegressionCase(caseId);
      try {
        const { run } = await this.service.runIsolated({ agentId: evalRun.target.agentId, workspaceTemplate: regressionCase.workspaceTemplate, prompt: regressionCase.prompt, tags: { evalRunId, caseId } });
        const finished = await this.service.waitForRun(run.id);
        await this.glassbox.emitter.flush();
        const view = buildTrace(await this.glassbox.store.readRun(run.id), { capturePolicy: this.glassbox.emitter.capturePolicy });
        const results = await evaluateAll(view, regressionCase.assertions);
        if (this.glassbox.evaluations && this.glassbox.summaries) {
          await rollupRun({ traces: this.glassbox.store, emitter: this.glassbox.emitter, summaries: this.glassbox.summaries }, run.id);
          const evaluatedAt = new Date().toISOString();
          for (const result of results) {
            await this.glassbox.evaluations.putResult({
              runId: run.id, evaluatorId: result.type, evaluatorVersion: 1, passed: result.pass,
              explanation: result.message, evidenceEventIds: result.evidenceEventIds,
              metadata: { expected: result.expected, observed: result.observed }, evaluatedAt, jobId: evalRun.id,
            });
          }
        }
        // A Run that did not complete (runner threw, timed out, cancelled) fails the case; keep its evidence.
        const error = finished.status === "completed" ? undefined : finished.error ?? "Run " + finished.status;
        if (error) failed = true;
        await this.service.updateEvalRun(evalRunId, (item) => { item.runIds.push(run.id); item.results.push({ caseId, runId: run.id, results, ...(error ? { error } : {}) }); });
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        await this.service.updateEvalRun(evalRunId, (item) => item.results.push({ caseId, results: [], error: message }));
      }
    }
    await this.service.updateEvalRun(evalRunId, (item) => { item.status = failed ? "failed" : "completed"; item.completedAt = new Date().toISOString(); });
  }
}
