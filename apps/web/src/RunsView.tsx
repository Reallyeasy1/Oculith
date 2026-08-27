import { useMemo, useState } from "react";
import type { RunListItem } from "./types";
import {
  FILTER_LABEL,
  QUICK_FILTERS,
  STATUS_ICON,
  formatClock,
  formatDuration,
  formatUsage,
  liveRuns,
  matchesFilter,
  recoveredFailures,
  sortNewestFirst,
  summarizeRuns,
  type QuickFilter,
} from "./runs-view-model";

function noEvidenceTitle(run: RunListItem): string {
  const layers = [run.capabilities.model === "unknown" ? "model" : "", run.capabilities.tool === "unknown" ? "tool" : ""].filter(Boolean).join(" and ");
  return run.status === "timeout" || run.status === "cancelled" || run.status === "running"
    ? `No ${layers} evidence — the Run was cut short before calls were observed.`
    : `No ${layers} calls observed in this Run.`;
}

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
  const okCount = summarizeRuns(runs).ok;
  // Elapsed is computed at render time: the dashboard poll (#98) replaces `runs` every tick, so it ticks with the poll.
  const live = liveRuns(runs);
  const now = Date.now();

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
      {live.length > 0 && (
        <ul className="live-strip" aria-label="Live now">
          {live.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                className={"live-run" + (run.runId === selectedRunId ? " selected" : "")}
                aria-label={"Open trace for running Run" + (showAgent ? " of " + (run.agentName || run.agentId) : "")}
                onClick={() => onOpenTrace(run.runId)}
              >
                <span className="status status-running"><span aria-hidden="true">{STATUS_ICON.running}</span>live</span>
                {showAgent && <strong>{run.agentName || run.agentId}</strong>}
                <span>{formatDuration(run.startedAt ? Math.max(0, now - Date.parse(run.startedAt)) : undefined)} elapsed</span>
                <span>last event {formatClock(run.lastEventAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              {showAgent && <th scope="col">Agent</th>}
              <th scope="col">Workspace</th>
              <th scope="col">Start</th>
              <th scope="col">Duration</th>
              <th scope="col">First failing step</th>
              <th scope="col">Events</th>
              <th scope="col">Config</th>
              <th scope="col">Runtime / model</th>
              <th scope="col">Usage</th>
              <th scope="col">Tool calls</th>
              <th scope="col">Last event</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <tr
                key={run.runId}
                data-run-id={run.runId}
                tabIndex={0}
                role="button"
                className={run.runId === selectedRunId ? "selected" : undefined}
                aria-label={"Open trace for " + (run.agentName || run.runId) + ", " + run.status + ", " + formatClock(run.startedAt)}
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
                  {recoveredFailures(run) > 0 && (
                    <span className="badge badge-warn badge-recovered">recovered after {recoveredFailures(run)} {recoveredFailures(run) === 1 ? "failure" : "failures"}</span>
                  )}
                </td>
                {showAgent && <td>{run.agentName || run.agentId}</td>}
                <td>{run.workspace ?? "—"}</td>
                <td>{formatClock(run.startedAt)}</td>
                <td>{formatDuration(run.durationMs)}{run.endedReason === "server_restart" ? " · interrupted" : ""}</td>
                <td>{run.firstFailingStep ?? "—"}</td>
                <td>{run.eventCount}</td>
                <td title={run.configSnapshot ? JSON.stringify(run.configSnapshot) : undefined}>
                  <code>{run.configHash?.slice(0, 8) ?? "—"}</code>
                </td>
                <td>{run.runtime} · {run.model}</td>
                <td>{formatUsage(run.usage)}</td>
                <td>
                  <span>{run.toolCalls}{run.toolFailures > 0 && <> · {run.toolFailures} failed</>}</span>{" "}
                  {run.redacted && <span className="badge">redacted</span>}
                  {run.denials > 0 && <span className="badge badge-warn">denied {run.denials}</span>}
                  {run.actions > 0 && <span className="badge">actions {run.actions}</span>}
                  {run.degraded && <span className="badge badge-warn">degraded</span>}
                  {run.truncated && <span className="badge badge-warn">truncated</span>}
                  {run.evicted && <span className="badge badge-warn">evicted</span>}
                  {(run.capabilities.model === "unknown" || run.capabilities.tool === "unknown") && (
                    <span className="badge" title={noEvidenceTitle(run)}>no evidence</span>
                  )}
                  {run.workspaceChanges && <span className="badge">{run.workspaceChanges.added + run.workspaceChanges.modified + run.workspaceChanges.removed} files changed</span>}
                </td>
                <td>{formatClock(run.lastEventAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="runs-empty">
            {runs.length === 0 ? emptyText : filter === "attention" ? (
              <>
                Nothing needs attention · {okCount} ok {okCount === 1 ? "Run" : "Runs"}
                <button type="button" className="button button-ghost runs-empty-action" onClick={() => setFilter("all")}>Show all</button>
              </>
            ) : "No Runs match this filter."}
          </div>
        )}
      </div>
    </section>
  );
}
