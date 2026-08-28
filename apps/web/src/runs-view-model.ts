import type { RunListItem, TraceStatus } from "./types";

// Pure helpers for RunsView. Render only what the API returned — no client-side status inference.

export type QuickFilter = "attention" | "all" | "failed" | "running" | "cancelled" | "timeout" | "degraded";

export const QUICK_FILTERS: QuickFilter[] = ["attention", "all", "failed", "running", "cancelled", "timeout", "degraded"];

export const FILTER_LABEL: Partial<Record<QuickFilter, string>> = { attention: "Needs attention", timeout: "Timed out" };

/** #132 chip tooltip — the flag is a derived phrase match on the final message, not an evaluator judgement. */
export const REPORTED_FAILURE_HINT = "Derived: the agent's final message contains a failure phrase (e.g. \"not installed\", \"unable to\"). Not an evaluator judgement.";

/** Tool failures + denials an ok Run worked around (#131); 0 unless the Run ended ok. */
export function recoveredFailures(run: RunListItem): number {
  return run.status === "ok" ? run.toolFailures + run.denials : 0;
}

export interface EvidenceBadge {
  label: string;
  title: string;
  warn: boolean;
}

/** Keep absence claims layer-specific: zero observed calls is not the same as missing evidence. */
export function evidenceBadges(run: RunListItem): EvidenceBadge[] {
  if (run.status === "ok") {
    return run.toolCalls === 0
      ? [{ label: "no tool calls", title: "This Run completed successfully without any observed tool calls.", warn: false }]
      : [];
  }
  if (run.status === "running") return [];
  return (["model", "tool"] as const)
    .filter((layer) => run.capabilities[layer] === "unknown")
    .map((layer) => ({
      label: `${layer}: no evidence`,
      title: `No ${layer} events were observed and the Run did not end ok, so nothing can be said about this layer; absence proves nothing.`,
      warn: true,
    }));
}

/** error ∪ timeout ∪ cancelled ∪ degraded ∪ any tool failure/denial — the default Runs filter (#35, #131). */
export function needsAttention(run: RunListItem): boolean {
  return run.outcome?.reportedFailure === true || run.degraded || run.toolFailures > 0 || run.denials > 0 || run.status === "error" || run.status === "timeout" || run.status === "cancelled";
}

/** Running Runs, newest first — the "Live now" strip, independent of the quick filter (#131). */
export function liveRuns(runs: RunListItem[]): RunListItem[] {
  return sortNewestFirst(runs.filter((run) => run.status === "running"));
}

export interface RunsSummary {
  total: number;
  ok: number;
  attention: number;
  running: number;
  /** ok Runs that had tool failures or denials along the way. */
  recovered: number;
  agents: { agentId: string; name: string; count: number; attention: number }[];
}

/** Overview strip (#70): pure counts over the API's `status`/`degraded` — nothing is inferred client-side. */
export function summarizeRuns(runs: RunListItem[]): RunsSummary {
  const byAgent = new Map<string, RunsSummary["agents"][number]>();
  const summary: RunsSummary = { total: runs.length, ok: 0, attention: 0, running: 0, recovered: 0, agents: [] };
  for (const run of runs) {
    const bad = needsAttention(run);
    if (run.status === "ok") summary.ok++;
    if (run.status === "running") summary.running++;
    if (recoveredFailures(run) > 0) summary.recovered++;
    if (bad) summary.attention++;
    const agent = byAgent.get(run.agentId) ?? { agentId: run.agentId, name: run.agentName || run.agentId, count: 0, attention: 0 };
    agent.count++;
    if (bad) agent.attention++;
    byAgent.set(run.agentId, agent);
  }
  summary.agents = [...byAgent.values()].sort((a, b) => a.name.localeCompare(b.name));
  return summary;
}

// Text glyphs so status never relies on colour alone.
export const STATUS_ICON: Record<TraceStatus, string> = {
  running: "◌",
  ok: "✓",
  error: "✗",
  cancelled: "⊘",
  timeout: "⏱",
  unset: "?",
};

export function matchesFilter(run: RunListItem, filter: QuickFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return needsAttention(run);
    case "failed":
      return run.status === "error";
    case "degraded":
      return run.degraded;
    default:
      return run.status === filter;
  }
}

export function sortNewestFirst(runs: RunListItem[]): RunListItem[] {
  return [...runs].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

export function formatRunDuration(durationMs: number | undefined, endedReason?: "server_restart", interruptedAfterMs?: number): string {
  if (endedReason !== "server_restart") return formatDuration(durationMs);
  return `≥ ${formatDuration(interruptedAfterMs)} · interrupted (last evidence +${formatDuration(durationMs)})`;
}

export function formatUsage(usage: RunListItem["usage"]): string {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return "—";
  const compact = (value: number) => value >= 1000 ? (value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(value);
  return compact(usage.inputTokens ?? 0) + " in · " + compact(usage.outputTokens ?? 0) + " out";
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function formatClock(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : clock.format(date);
}
