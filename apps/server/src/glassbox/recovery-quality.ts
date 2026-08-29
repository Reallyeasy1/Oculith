import type { EvaluatorDefinition } from "./evaluation.js";
import type { RunEvaluation, RunEvaluator } from "./jobs.js";
import type { ObservationEvent } from "./schema.js";
import type { RunSummary } from "./summary.js";
import {
  acceptJudgeVerdict,
  buildEvaluationView,
  type TaskCompletionJudge,
  type TaskCompletionSource,
} from "./task-completion.js";

/**
 * recovery_quality@1 (#177): the second semantic metric, judged over the same evaluation view and
 * source adapter as task_completion. Only Runs whose trace shows at least one tool failure, policy
 * denial or runtime error are eligible — the judge is never called for a clean Run; a notEligible
 * verdict is stored instead so job progress stays derived from results. Never sets taskOutcome.
 */

/**
 * A failure the Agent had the chance to recover from: a policy denial, or any event that ended in
 * error/timeout (tool failures and runtime errors included). A user cancel is not a failure the
 * Agent could address, so `cancelled` does not make a Run eligible.
 */
export const isRecoverableFailure = (event: ObservationEvent): boolean =>
  event.type === "policy.denied" || event.status === "error" || event.status === "timeout";

export class RecoveryQualityEvaluator implements RunEvaluator {
  constructor(private readonly source: TaskCompletionSource, private readonly judge: TaskCompletionJudge) {}

  async evaluate(summary: RunSummary, definition: EvaluatorDefinition): Promise<RunEvaluation> {
    const source = await this.source.load(summary.runId);
    // Never judge from zero evidence: a Run whose events were evicted is a per-Run job failure with
    // provenance (same rule as safety@1), not an ineligible or clean verdict.
    if (source.events.length === 0 && summary.eventCount > 0) {
      throw new Error(`recovery_quality@${definition.version}: no stored events for run ${summary.runId} (evidence evicted or unavailable)`);
    }
    const failures = source.events.filter(isRecoverableFailure);
    if (failures.length === 0) {
      return {
        passed: true,
        explanation: `Not eligible: no tool failure, policy denial, or runtime error was observed across ${source.events.length} stored event${source.events.length === 1 ? "" : "s"}, so there was nothing to recover from.`,
        evidenceEventIds: [],
        metadata: { notEligible: true, observedEvents: source.events.length },
      };
    }
    // Silent abandonment is exactly what this metric must catch: a Run that failed and never
    // produced a final response is judged over an empty response, not skipped.
    const view = buildEvaluationView({ summary, userRequest: source.userRequest, finalResponse: source.finalResponse ?? "", events: source.events });
    const verdict = acceptJudgeVerdict(definition, view, await this.judge.judge({ definition, view: view.text }));
    const failureIds = new Set(failures.map((event) => event.eventId));
    return {
      score: verdict.score,
      passed: verdict.passed,
      explanation: verdict.explanation,
      evidenceEventIds: verdict.citedEventIds,
      evaluatorModel: this.judge.model,
      metadata: {
        failuresObserved: failures.length,
        ...(verdict.uncited ? { uncited: true } : {}),
        // The acceptance bar cites the failure alongside the recovery: flag a verdict whose
        // surviving citations name no failure event so the UI can show the gap honestly.
        ...(verdict.citedEventIds.some((id) => failureIds.has(id)) ? {} : { failureUncited: true }),
        ...(view.truncated ? { viewTruncated: true } : {}),
        ...(source.finalResponse === undefined ? { noFinalResponse: true } : {}),
      },
    };
  }
}
