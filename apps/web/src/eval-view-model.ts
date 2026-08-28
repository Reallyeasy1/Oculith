import type { EvalRun, EvaluationResult } from "./types";

/** "task_completion@1" — the provenance label every evaluation surface shows (#173). */
export function evaluatorLabel(result: Pick<EvaluationResult, "evaluatorId" | "evaluatorVersion">): string {
  return `${result.evaluatorId}@${result.evaluatorVersion}`;
}

/** Stable "key: value · key: value" summary of a result's metadata; empty string when there is none. */
export function metadataSummary(metadata: EvaluationResult["metadata"]): string {
  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

export function templateHashDetails(evalRun: Pick<EvalRun, "templateHashes">): { name: string; hash: string; shortHash: string }[] {
  return Object.entries(evalRun.templateHashes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => ({ name, hash, shortHash: hash.slice(0, 8) }));
}
