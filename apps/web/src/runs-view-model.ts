import type { RunListItem, TraceStatus } from "./types";

// Pure helpers for RunsView. Render only what the API returned — no client-side status inference.

export type QuickFilter = "attention" | "all" | "failed" | "running" | "cancelled" | "timeout" | "degraded";

export const QUICK_FILTERS: QuickFilter[] = ["attention", "all", "failed", "running", "cancelled", "timeout", "degraded"];

export const FILTER_LABEL: Partial<Record<QuickFilter, string>> = { attention: "Needs attention", timeout: "Timed out" };

/** Tool failures + denials an ok Run worked around (#131); 0 unless the Run ended ok. */
export function recoveredFailures(run: RunListItem): number {
  return run.status === "ok" ? run.toolFailures + run.denials : 0;
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

export function formatUsage(usage: RunListItem["usage"]): string {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return "—";
  return (usage.inputTokens ?? 0) + " in · " + (usage.outputTokens ?? 0) + " out";
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function formatClock(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : clock.format(date);
}
