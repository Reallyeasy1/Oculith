import { useEffect, useMemo, useState } from "react";
import type { AgentRunBaseline, RunListItem } from "./types";
import type { ReliabilityDrill } from "./reliability-view-model";
import {
  FILTER_LABEL,
  QUICK_FILTERS,
  REPORTED_FAILURE_HINT,
  TASK_OUTCOME_FILTERS,
  TASK_OUTCOME_HINT,
  errorHead,
  evidenceBadges,
  STATUS_ICON,
  formatClock,
  formatCount,
  formatCost,
  formatDuration,
  formatUsage,
  liveRuns,
  matchesFilter,
  matchesProvenance,
  matchesTaskOutcome,
  outlierLabel,
  recoveredFailures,
  runDurationCell,
  runOutlier,
  runsColumns,
  sortNewestFirst,
  summarizeRuns,
  taskOutcomeChip,
  taskOutcomeProvenance,
  workspaceLabel,
  type QuickFilter,
  type TaskOutcomeFilter,
} from "./runs-view-model";

interface Props {
  runs: RunListItem[];
  selectedRunId: string | null;
  onOpenTrace: (runId: string) => void;
  /** Agent column; off in the per-Agent view where every row belongs to the same Agent (#70). */
  showAgent?: boolean;
  title?: string;
  emptyText?: string;
  baseline?: AgentRunBaseline | null;
  /** #173 drill-back from a ReliabilityPanel tile: applies its filters when the object changes. */
  drill?: ReliabilityDrill | null;
}

export default function RunsView({ runs, selectedRunId, onOpenTrace, showAgent = true, title = "Runs", emptyText = "No Runs observed yet.", baseline, drill }: Props) {
  const [filter, setFilter] = useState<QuickFilter>("attention");
  const [taskOutcome, setTaskOutcome] = useState<TaskOutcomeFilter>("all");
  const [provenanceRunIds, setProvenanceRunIds] = useState<string[] | undefined>();
  useEffect(() => {
    if (!drill) return;
    setFilter(drill.quick);
    setTaskOutcome(drill.taskOutcome);
    setProvenanceRunIds(drill.runIds);
    document.getElementById("runs-heading")?.focus();
  }, [drill]);
  const visible = useMemo(
    () => sortNewestFirst(runs).filter((run) => matchesFilter(run, filter) && matchesTaskOutcome(run, taskOutcome) && matchesProvenance(run, provenanceRunIds)),
    [runs, filter, taskOutcome, provenanceRunIds],
  );
  const okCount = summarizeRuns(runs).ok;
  // Elapsed is computed at render time: the dashboard poll (#98) replaces `runs` every tick, so it ticks with the poll.
  const live = liveRuns(runs);
  const now = Date.now();
  // #338 — a column empty ("—") on every listed Run is hidden (extends the old showCost check).
  const cols = runsColumns(runs);

  return (
    <section className="runs-view" aria-labelledby="runs-heading">
      <div className="playground-topbar">
        <div>
          <span className="eyebrow">GlassBox</span>
          <h2 id="runs-heading" tabIndex={-1}>{title}</h2>
        </div>
        <div className="runs-filters" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className="button button-ghost"
              aria-pressed={filter === item}
              onClick={() => { setFilter(item); setProvenanceRunIds(undefined); }}
            >
              {FILTER_LABEL[item] ?? item}
            </button>
          ))}
        </div>
        <div className="runs-task-filters" role="group" aria-label="Task outcome filter" title={TASK_OUTCOME_HINT}>
          <span className="runs-task-filters-label">Task</span>
          {TASK_OUTCOME_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className="button button-ghost"
              aria-pressed={taskOutcome === item}
              onClick={() => { setTaskOutcome(item); setProvenanceRunIds(undefined); }}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      {provenanceRunIds && (
        <p className="runs-baseline comparison-drill-status" role="status">
          Config comparison · {provenanceRunIds.length} {provenanceRunIds.length === 1 ? "Run" : "Runs"}
          <button type="button" className="evidence-link" onClick={() => setProvenanceRunIds(undefined)}>Clear</button>
        </p>
      )}
      {!showAgent && baseline && baseline.sampleCount > 0 && (
        <p className="runs-baseline" aria-label={`Baseline over ${baseline.sampleCount} ${baseline.sampleCount === 1 ? "Run" : "Runs"}`}>
          p50 {formatDuration(baseline.durationMs.p50)} · {formatCount(baseline.inputTokens.p50)} in · {formatCount(baseline.toolCalls.p50)} tools ({baseline.sampleCount} {baseline.sampleCount === 1 ? "Run" : "Runs"})
        </p>
      )}
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
      <div className="runs-table-wrap runs-table-wrap-scroll-hint">
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              {showAgent && <th scope="col">Agent</th>}
              <th scope="col">Workspace</th>
              <th scope="col">Start</th>
              <th scope="col" className="num">Duration</th>
              {cols.outcome && <th scope="col">Outcome</th>}
              {cols.task && <th scope="col">Task</th>}
              {cols.failStep && <th scope="col">First failing step</th>}
              <th scope="col" className="num">Events</th>
              {cols.config && <th scope="col">Config</th>}
              <th scope="col">Runtime / model</th>
              {cols.usage && <th scope="col" className="num">Usage</th>}
              {cols.cost && <th scope="col" className="num">Est. cost</th>}
              <th scope="col">Tool calls</th>
              <th scope="col">Last event</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => {
              const task = taskOutcomeChip(run);
              const taskSource = task ? taskOutcomeProvenance(run.taskOutcomeSource) : undefined;
              const outlier = runOutlier(run, baseline);
              const duration = runDurationCell(run.durationMs, run.endedReason, run.interruptedAfterMs);
              const outlierTitle = outlier ? [outlier.durationMultiple === undefined ? "" : `duration ×${outlier.durationMultiple.toFixed(1)}`, outlier.inputTokensMultiple === undefined ? "" : `tokens ×${outlier.inputTokensMultiple.toFixed(1)}`].filter(Boolean).join(" · ") + ` versus the last ${baseline?.sampleCount ?? 0} terminal Runs` : undefined;
              return (
              <tr
                key={run.runId}
                data-run-id={run.runId}
                role="button"
                tabIndex={0}
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
                <td className="runs-status">
                  <span className={"status status-" + run.status}>
                    <span aria-hidden="true">{STATUS_ICON[run.status]}</span>
                    {run.status}
                  </span>
                  {recoveredFailures(run) > 0 && (
                    <span className="badge badge-warn badge-recovered">recovered after {recoveredFailures(run)} {recoveredFailures(run) === 1 ? "failure" : "failures"}</span>
                  )}
                  {outlier && <span className="badge badge-warn badge-outlier" title={outlierTitle}>{outlierLabel(outlier)}</span>}
                </td>
                {showAgent && <td>{run.agentName || run.agentId}</td>}
                <td className="runs-workspace" title={workspaceLabel(run.workspace, run.agentId).title ?? workspaceLabel(run.workspace, run.agentId).text}>{workspaceLabel(run.workspace, run.agentId).text}</td>
                <td>{formatClock(run.startedAt)}</td>
                <td className="num" title={duration.title}>{duration.text}</td>
                {cols.outcome && <td className="runs-outcome" title={run.outcome?.text}>{run.outcome?.text ?? (run.outcome?.reportedFailure ? <span className="badge badge-warn" title={REPORTED_FAILURE_HINT}>agent reported failure</span> : <span className="dash">—</span>)}</td>}
                {cols.task && <td className="runs-task">{task ? <span className="runs-task-verdict"><span className={"badge" + (task.warn ? " badge-warn" : "")} title={TASK_OUTCOME_HINT}>{task.label}</span>{taskSource && <span className="runs-task-source" title={taskSource.title}>{taskSource.label}</span>}</span> : <span className="dash">—</span>}</td>}
                {/* #263: cell text is a truncated head; the full step text stays in the title tooltip. */}
                {cols.failStep && <td className="runs-fail-step" title={run.firstFailingStep}>{run.firstFailingStep ? errorHead(run.firstFailingStep) : <span className="dash">—</span>}</td>}
                <td className="num">{run.eventCount}</td>
                {cols.config && (
                  <td title={run.configSnapshot ? JSON.stringify(run.configSnapshot) : undefined}>
                    <code>{run.configHash?.slice(0, 8) ?? <span className="dash">—</span>}</code>
                  </td>
                )}
                <td className="runs-runtime" title={run.runtime + " · " + run.model}>{run.runtime} · {run.model}</td>
                {cols.usage && <td className="num">{formatUsage(run.usage)}</td>}
                {cols.cost && <td className="num">{formatCost(run.estimatedCostUsd)}</td>}
                <td className="runs-tools" title={run.toolIdentities?.join(", ")}>
                  <span className="tool-call-summary">
                    <span>{run.toolCalls}{run.toolFailures > 0 && <> · {run.toolFailures} failed</>}</span>
                    {run.redacted && <span className="badge">redacted</span>}
                    {run.denials > 0 && <span className="badge badge-warn">denied {run.denials}</span>}
                    {run.actions > 0 && <span className="badge">actions {run.actions}</span>}
                    {run.degraded && <span className="badge badge-warn">degraded</span>}
                    {run.truncated && <span className="badge badge-warn">truncated</span>}
                    {run.evicted && <span className="badge badge-warn">evicted</span>}
                    {evidenceBadges(run).map((badge) => (
                      <span key={badge.label} className={"badge" + (badge.warn ? " badge-warn" : "")} title={badge.title}>{badge.label}</span>
                    ))}
                    {run.workspaceChanges && <span className="badge">{run.workspaceChanges.added + run.workspaceChanges.modified + run.workspaceChanges.removed} files changed</span>}
                  </span>
                </td>
                <td>{formatClock(run.lastEventAt)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="runs-empty">
            {runs.length === 0 ? emptyText : filter === "attention" && taskOutcome === "all" ? (
              <>
                Nothing needs attention · {okCount} ok {okCount === 1 ? "Run" : "Runs"}
                <button type="button" className="button button-ghost runs-empty-action" onClick={() => setFilter("all")}>Show all</button>
              </>
            ) : (
              <>
                No Runs match this filter.
                <button type="button" className="button button-ghost runs-empty-action" onClick={() => { setFilter("attention"); setTaskOutcome("all"); }}>Clear filters</button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
