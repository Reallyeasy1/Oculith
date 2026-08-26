import { useMemo, useState } from "react";
import type { RunListItem } from "./types";
import {
  FILTER_LABEL,
  QUICK_FILTERS,
  STATUS_ICON,
  formatClock,
  formatDuration,
  formatUsage,
  matchesFilter,
  sortNewestFirst,
  type QuickFilter,
} from "./runs-view-model";

interface Props {
  runs: RunListItem[];
  selectedRunId: string | null;
  onOpenTrace: (runId: string) => void;
  /** Agent column; off in the per-Agent view where every row belongs to the same Agent (#70). */
  showAgent?: boolean;
  title?: string;
  emptyText?: string;
}

export default function RunsView({ runs, selectedRunId, onOpenTrace, showAgent = true, title = "Runs", emptyText = "No Runs observed yet." }: Props) {
  const [filter, setFilter] = useState<QuickFilter>("attention");
  const visible = useMemo(
    () => sortNewestFirst(runs).filter((run) => matchesFilter(run, filter)),
    [runs, filter],
  );

  return (
    <section className="runs-view" aria-labelledby="runs-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">GlassBox</span>
          <h2 id="runs-heading">{title}</h2>
        </div>
        <div className="runs-filters" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className="button button-ghost"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {FILTER_LABEL[item] ?? item}
            </button>
          ))}
        </div>
      </div>
      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              {showAgent && <th scope="col">Agent</th>}
              <th scope="col">Start</th>
              <th scope="col">Duration</th>
              <th scope="col">First failing step</th>
              <th scope="col">Events</th>
              <th scope="col">Runtime / model</th>
              <th scope="col">Usage</th>
              <th scope="col">Trust</th>
              <th scope="col">Last event</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <tr
                key={run.runId}
                tabIndex={0}
                className={run.runId === selectedRunId ? "selected" : undefined}
                aria-label={"Open trace for " + (run.agentName || run.runId) + ", " + run.status}
                onClick={() => onOpenTrace(run.runId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenTrace(run.runId);
                  }
                }}
              >
                <td>
                  <span className={"status status-" + run.status}>
                    <span aria-hidden="true">{STATUS_ICON[run.status]}</span>
                    {run.status}
                  </span>
                </td>
                {showAgent && <td>{run.agentName || run.agentId}</td>}
                <td>{formatClock(run.startedAt)}</td>
                <td>{formatDuration(run.durationMs)}{run.endedReason === "server_restart" ? " until restart" : ""}</td>
                <td>{run.firstFailingStep ?? "—"}</td>
                <td>{run.eventCount}</td>
                <td>{run.runtime} · {run.model}</td>
                <td>{formatUsage(run.usage)}</td>
                <td>
                  {run.redacted && <span className="badge">redacted</span>}
                  {run.degraded && <span className="badge badge-warn">degraded</span>}
                  {run.truncated && <span className="badge badge-warn">truncated</span>}
                  {run.workspaceChanges && <span className="badge">{run.workspaceChanges.added + run.workspaceChanges.modified + run.workspaceChanges.removed} files changed</span>}
                  {!run.redacted && !run.degraded && !run.truncated && !run.workspaceChanges && "—"}
                </td>
                <td>{formatClock(run.lastEventAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="runs-empty">
            {runs.length === 0 ? emptyText : filter === "attention" ? "Nothing needs attention." : "No Runs match this filter."}
          </p>
        )}
      </div>
    </section>
  );
}
