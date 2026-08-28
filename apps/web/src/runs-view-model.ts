import type { AgentRunBaseline, RunListItem, TraceStatus, Workspace } from "./types";

// Pure helpers for RunsView. Render only what the API returned — no client-side status inference.

export type QuickFilter = "attention" | "all" | "failed" | "running" | "cancelled" | "timeout" | "degraded";

export const QUICK_FILTERS: QuickFilter[] = ["attention", "all", "failed", "running", "cancelled", "timeout", "degraded"];

export const FILTER_LABEL: Partial<Record<QuickFilter, string>> = { attention: "Needs attention", timeout: "Timed out" };

export function workspaceLabel(workspace: string | undefined, agentId: string): { text: string; title?: string } {
  if (!workspace) return { text: "—" };
  return workspace === agentId ? { text: "managed", title: workspace } : { text: workspace };
}

export function workspaceOptionLabel(workspace: Workspace): string {
  const agents = `${workspace.agents.length} ${workspace.agents.length === 1 ? "agent" : "agents"}`;
  return `${workspace.name} · ${agents} · ${workspace.managed ? "managed" : "unmanaged"} · ${workspace.fileCount} files`;
}

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
  return formatCount(usage.inputTokens ?? 0) + " in · " + formatCount(usage.outputTokens ?? 0) + " out";
}

export function formatCount(value: number | undefined): string {
  if (value === undefined) return "—";
  return value >= 1000 ? (value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(value);
}

export interface RunOutlier { durationMultiple?: number; inputTokensMultiple?: number }

/** A baseline is too noisy below three terminal Runs; ratios require a positive p50. */
export function runOutlier(run: RunListItem, baseline: AgentRunBaseline | null | undefined): RunOutlier | undefined {
  if (!baseline || baseline.sampleCount < 3) return undefined;
  const durationMultiple = baseline.durationMs.p50 && run.durationMs !== undefined ? run.durationMs / baseline.durationMs.p50 : undefined;
  const inputTokensMultiple = baseline.inputTokens.p50 && run.usage?.inputTokens !== undefined ? run.usage.inputTokens / baseline.inputTokens.p50 : undefined;
  const outlier = {
    ...(durationMultiple !== undefined && durationMultiple > 3 ? { durationMultiple } : {}),
    ...(inputTokensMultiple !== undefined && inputTokensMultiple > 3 ? { inputTokensMultiple } : {}),
  };
  return Object.keys(outlier).length === 0 ? undefined : outlier;
}

export function formatCost(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 0.01 ? "$" + value.toFixed(4) : "$" + value.toFixed(2);
}

function formatMultiple(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function outlierLabel(outlier: RunOutlier): string {
  if (outlier.inputTokensMultiple !== undefined) return `outlier ×${formatMultiple(outlier.inputTokensMultiple)} tokens`;
  return `outlier ×${formatMultiple(outlier.durationMultiple!)} duration`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function formatClock(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : clock.format(date);
}
