import { formatDuration } from "./runs-view-model";
import type { EvalRun, EvaluationResult } from "./types";

/** "task_completion@1" — the provenance label every evaluation surface shows (#173). */
export function evaluatorLabel(result: Pick<EvaluationResult, "evaluatorId" | "evaluatorVersion">): string {
  return `${result.evaluatorId}@${result.evaluatorVersion}`;
}

/**
 * #346: metadata as renderable parts for the trace Evaluation panel — sorted "key: value" pairs,
 * with max_duration_ms expected/observed humanized (raw ms kept as a title).
 */
export function metadataParts(result: Pick<EvaluationResult, "evaluatorId" | "metadata">): { text: string; title?: string }[] {
  return Object.entries(result.metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) =>
      result.evaluatorId === "max_duration_ms" && (key === "expected" || key === "observed") && typeof value === "number"
        ? { text: `${key}: ${formatDuration(value)}`, title: `${value} ms` }
        : { text: `${key}: ${String(value)}` });
}

export function templateHashDetails(evalRun: Pick<EvalRun, "templateHashes">): { name: string; hash: string; shortHash: string }[] {
  return Object.entries(evalRun.templateHashes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => ({ name, hash, shortHash: hash.slice(0, 8) }));
}
