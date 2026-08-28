import type { EvalRun } from "./types";

export function templateHashDetails(evalRun: Pick<EvalRun, "templateHashes">): { name: string; hash: string; shortHash: string }[] {
  return Object.entries(evalRun.templateHashes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => ({ name, hash, shortHash: hash.slice(0, 8) }));
}
