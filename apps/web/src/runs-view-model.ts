import type { RunListItem, TraceStatus } from "./types";

// Pure helpers for RunsView. Render only what the API returned — no client-side status inference.

export type QuickFilter = "all" | "failed" | "running" | "cancelled" | "timeout" | "degraded";

export const QUICK_FILTERS: QuickFilter[] = ["all", "failed", "running", "cancelled", "timeout", "degraded"];

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

export function formatClock(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}
