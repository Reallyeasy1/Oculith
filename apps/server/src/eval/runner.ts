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
        // A Run that did not complete (runner threw, timed out, cancelled) fails the case; keep its evidence.
        const error = finished.status === "completed" ? undefined : finished.error ?? "Run " + finished.status;
        if (error) failed = true;
        // FR-21 adapter: one EvaluationResult per (run, evaluator, version), so several assertions of one type fold
        // into one verdict (all must pass) instead of the last write shadowing the others. The summary row must
        // exist before putResult (setTaskOutcome 404s otherwise) — rollupRun is idempotent, so roll up here.
        if (this.glassbox.evaluations && this.glassbox.summaries && await rollupRun({ traces: this.glassbox.store, emitter: this.glassbox.emitter, summaries: this.glassbox.summaries }, run.id)) {
          const evaluatedAt = new Date().toISOString();
          const byType = new Map<string, typeof results>();
          for (const result of results) byType.set(result.type, [...(byType.get(result.type) ?? []), result]);
          for (const [type, group] of byType) {
            const [single] = group;
            await this.glassbox.evaluations.putResult({
              runId: run.id, evaluatorId: type, evaluatorVersion: 1, passed: group.every((result) => result.pass),
              explanation: group.map((result) => result.message).join(" "), evidenceEventIds: [...new Set(group.flatMap((result) => result.evidenceEventIds))],
              metadata: group.length === 1 && single ? { expected: single.expected, observed: single.observed } : { assertions: group.length },
              evaluatedAt, jobId: evalRun.id,
            });
          }
          // FR-22: the case's assertions are the caller's definition of task success, so a deterministic miss
          // (budget assertions included) or a Run that never completed marks the task failed.
          await this.glassbox.summaries.setTaskOutcome(run.id, !error && results.every((result) => result.pass) ? "passed" : "failed", `deterministic:${evalRunId}`);
        }
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
