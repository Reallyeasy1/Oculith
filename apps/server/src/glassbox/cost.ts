import type { RunSummary } from "./summary.js";

export interface TokenPricing {
  inputPerMillion?: number | undefined;
  cachedInputPerMillion?: number | undefined;
  outputPerMillion?: number | undefined;
}

/** Prices only observed token classes. Cached input is a subset of input and falls back to its rate. */
export function estimatedCost(summary: RunSummary, pricing: TokenPricing): number | undefined {
  const input = summary.usage?.inputTokens ?? summary.metrics.tokens?.input;
  const cachedObserved = summary.usage?.cachedInputTokens ?? summary.metrics.tokens?.cachedInput;
  const output = summary.usage?.outputTokens ?? summary.metrics.tokens?.output;
  const cached = input === undefined || cachedObserved === undefined ? cachedObserved : Math.min(input, cachedObserved);
  const uncachedInput = input === undefined ? undefined : Math.max(0, input - (cached ?? 0));
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const hasInput = uncachedInput !== undefined && pricing.inputPerMillion !== undefined;
  const hasCached = cached !== undefined && cachedRate !== undefined;
  const hasOutput = output !== undefined && pricing.outputPerMillion !== undefined;
  if (!hasInput && !hasCached && !hasOutput) return undefined;
  return ((hasInput ? uncachedInput! * pricing.inputPerMillion! : 0)
    + (hasCached ? cached! * cachedRate! : 0)
    + (hasOutput ? output! * pricing.outputPerMillion! : 0)) / 1_000_000;
}
