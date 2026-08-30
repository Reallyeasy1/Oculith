import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Assertion, AuditRow, EvaluationResult, ObservationEvent, RunListItem, RunLogLine, Span, TraceView } from "./types";
import { evaluatorLabel, metadataParts } from "./eval-view-model";
import { REPORTED_FAILURE_HINT, STATUS_ICON, collapseRequestId, errorHead, formatClock, formatDuration, formatRunDuration, formatUsage, pluralize, workspaceLabel } from "./runs-view-model";
import {
  CATEGORIES,
  DRAWER_EVENT_CAP,
  EMPTY_FILTER,
  STATUSES,
  barGeometry,
  capabilityBadgeLabel,
  capabilityCopy,
  coalesceErrorRows,
  defaultExpanded,
  firstFailedSpanId,
  formatActors,
  formatAuditActor,
  formatReasoningTokens,
  formatAttribute,
  isFailed,
  indexSpans,
  interruptedSpanDurationMs,
  isFilterActive,
  spanArgument,
  spanFillStatus,
  spanStatusLabel,
  timelineTicks,
  trimDiagnosis,
  visibleRows,
  type TraceFilter,
} from "./trace-view-model";

// Three capability states (PRD §8): observed | unavailable | unknown. Unknown remains pending while a
// Run is live; only a failed Run turns it into a warning (#137) — an ok chat-only Run legitimately has no tool evidence.
function CapabilityBadge({ layer, state, status }: {
  layer: "model" | "tool";
  state: "observed" | "unavailable" | "unknown";
  status: TraceView["summary"]["status"];
}) {
  const copy = capabilityCopy(state, status);
  return <span className={"badge" + (state === "unknown" && isFailed(status) ? " badge-warn" : "")} title={layer + ": " + copy.title}>{capabilityBadgeLabel(layer, state, status)}</span>;
}

interface Props {
  runId: string;
  /** Runs-list row for this Run (agent name, runtime, model live there, not on TraceSummary). */
  run: RunListItem | undefined;
  view: TraceView | null;
  templateBacked: boolean;
  focusEventId: string | null;
  onFocusHandled: () => void;
  onCaseSaved: () => Promise<void>;
  /** #256: re-dispatch this Run's originating prompt as an ordinary new Run (busy Agent → error banner). */
  onRerun: (runId: string) => void;
  onClose: () => void;
  /** #217: lets the workspace field tell a shared workspace from a managed one. */
  workspaces?: readonly { name: string; managed: boolean }[];
}

// Trace detail (UX-02): summary header, first-error banner with Jump, nested tree with duration bars,
// client-side filters, focus-trapped span drawer. Everything shown comes straight from the API payload.
export default function TraceDetail({ runId, run, view, templateBacked, focusEventId, onFocusHandled, onCaseSaved, onRerun, onClose, workspaces }: Props) {
  const [filter, setFilter] = useState<TraceFilter>(EMPTY_FILTER);
  // null = untouched → follow the API's default (roots + failure path) even as the trace grows while polling.
  const [expandedState, setExpanded] = useState<Set<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [logs, setLogs] = useState<RunLogLine[]>([]);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [logLevel, setLogLevel] = useState("");
  const [showSaveCase, setShowSaveCase] = useState(false);
  const saveCaseRef = useRef<HTMLFormElement>(null);
  const onSaveCaseKeyDown = useFocusTrap(saveCaseRef, () => { if (!savingCase) setShowSaveCase(false); }, String(showSaveCase));
  const [caseName, setCaseName] = useState("");
  const [caseAssertions, setCaseAssertions] = useState<Assertion[]>([]);
  // #341: include/exclude checkboxes instead of one-way Delete — indexes are stable once the draft loads.
  const [excludedChecks, setExcludedChecks] = useState<Set<number>>(new Set());
  const [savingCase, setSavingCase] = useState(false);
  const [caseError, setCaseError] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<EvaluationResult[]>([]);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Bumped whenever focus must move programmatically (keyboard nav, Jump, drawer close); the effect below
  // runs after the target row has rendered, which matters when Jump expands a collapsed path.
  const [focusReq, setFocusReq] = useState(0);
  // Once per open (App keys this component by runId): bring the header + banner into the first viewport.
  // #371: fire again when the trace payload lands — on deep links the panels above (Reliability,
  // comparison) populate after the mount scroll and push the loading placeholder below the fold.
  // Poll refreshes keep `loaded` true, so this never scroll-jacks a reading user.
  const sectionRef = useRef<HTMLElement>(null);
  const loaded = view !== null;
  useEffect(() => { sectionRef.current?.scrollIntoView({ block: "start" }); }, [loaded]);
  useEffect(() => {
    void api.logs(runId, logLevel).then((result) => { setLogs(result.lines); setLogsTruncated(result.truncated); }).catch(() => undefined);
  }, [logLevel, runId]);

  const byId = useMemo(() => (view ? indexSpans(view.spans) : new Map<string, Span>()), [view]);
  // Per-row redaction comes from the full event list: the server only nests intermediate events under
  // `span.events`, and redaction usually lands on the span's own start/end event.
  const redactedSpans = useMemo(() => new Set(view?.events.filter((e) => e.privacy.redacted).map((e) => e.spanId)), [view]);
  const expanded = useMemo(() => expandedState ?? (view ? defaultExpanded(view) : new Set<string>()), [expandedState, view]);
  const rows = useMemo(() => {
    if (!view) return [];
    const base = visibleRows(view.spans, expanded, filter);
    return filter.errorsOnly ? coalesceErrorRows(base) : base;
  }, [view, expanded, filter]);
  const ticks = useMemo(() => timelineTicks(view?.summary.durationMs), [view?.summary.durationMs]);
  const rovingId = focusId && rows.some((r) => r.span.spanId === focusId) ? focusId : (rows[0]?.span.spanId ?? null);

  // Refresh audit rows alongside the trace while the panel is visible; this is derived data, so the
  // trace remains the source of truth for navigating to the supporting span.
  useEffect(() => {
    if (!showAudit) return;
    let cancelled = false;
    void api.audit(runId)
      .then(({ audit }) => { if (!cancelled) { setAuditRows(audit); setAuditError(null); } })
      .catch((reason) => { if (!cancelled) setAuditError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [runId, showAudit, view]);

  // #173: stored evaluation results refresh alongside the trace poll (`view` changes every tick while
  // open). A server without the evaluation store (404) or a Run without results keeps the panel hidden.
  useEffect(() => {
    let cancelled = false;
    void api.runEvaluations(runId)
      .then(({ evaluations: results }) => { if (!cancelled) setEvaluations(results); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [runId, view]);

  useEffect(() => {
    if (focusReq > 0 && rovingId) rowRefs.current.get(rovingId)?.focus();
  }, [focusReq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view || view.summary.runId !== runId || !focusEventId) return;
    const event = view.events.find((item) => item.eventId === focusEventId);
    if (!event) { onFocusHandled(); return; }
    const path: string[] = [];
    const parents = indexSpans(view.spans);
    let current = parents.get(event.spanId);
    while (current) { path.unshift(current.spanId); current = current.parentSpanId ? parents.get(current.parentSpanId) : undefined; }
    setExpanded((previous) => new Set([...(previous ?? defaultExpanded(view)), ...path]));
    setFocusId(event.spanId);
    setOpenId(event.spanId);
    onFocusHandled();
  }, [focusEventId, onFocusHandled, view]);

  if (!view) {
    return (
      <section ref={sectionRef} className="runs-view trace-detail" aria-live="polite">
        <div className="playground-topbar trace-header">
          <div>
            <span className="eyebrow">Trace</span>
            <h2>Loading trace for <code>{runId}</code>…</h2>
          </div>
          <button type="button" className="button button-ghost" onClick={onClose}>Close trace</button>
        </div>
      </section>
    );
  }

  const { summary } = view;
  const failure = summary.failure;
  const workspace = workspaceLabel(summary.workspace ?? run?.workspace, summary.agentId || run?.agentId || "", workspaces);
  const actors = formatActors(summary.audit);
  const failingSpan = failure && byId.get(failure.spanId);
  // An ok Run can still contain recovered tool failures worth anchoring to (#pass-2); failed Runs keep the full banner.
  const recoveredFailureId = !failure && summary.status === "ok" && summary.metrics.toolFailures > 0 ? firstFailedSpanId(view.spans) : undefined;
  const openSpan = openId ? byId.get(openId) : undefined;
  const saveReason = summary.status !== "ok"
    ? "Only successful Runs can become regression cases."
    : !templateBacked
      ? "This Run did not start from a template-backed workspace."
      : "";

  const openSaveCase = () => {
    // The server derives the draft from the same trace it will persist from; nothing is saved until Save.
    setCaseName("");
    setCaseAssertions([]);
    setExcludedChecks(new Set());
    setCaseError(null);
    setShowSaveCase(true);
    api.regressionCaseDraft(runId)
      .then(({ draft }) => { setCaseName(draft.name); setCaseAssertions(draft.assertions); })
      .catch((reason) => setCaseError(reason instanceof Error ? reason.message : String(reason)));
  };
  const includedAssertions = caseAssertions.filter((_, index) => !excludedChecks.has(index));
  const saveCase = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!caseName.trim() || includedAssertions.length === 0) return;
    setSavingCase(true);
    setCaseError(null);
    try {
      await api.saveRunAsRegressionCase(runId, { name: caseName.trim(), assertions: includedAssertions });
      setShowSaveCase(false); // the case exists now; a failed list refresh must not invite a duplicate Save
      await onCaseSaved();
    } catch (reason) {
      setCaseError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingCase(false);
    }
  };

  const focusRow = (id: string) => { setFocusId(id); setFocusReq((n) => n + 1); };
  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => { const next = new Set(prev ?? expanded); if (open) next.add(id); else next.delete(id); return next; });

  // Shared by the failure banner and the ok-Run tool-failure anchor: clear filters, expand the path,
  // open the drawer too: row click → Jump lands on status/duration/error/summary in 2 interactions (PRD §64).
  // The drawer's own focus effect takes focus; closeDrawer hands it back to this row.
  const jumpToSpan = (spanId: string, path: string[]) => {
    setFilter(EMPTY_FILTER);
    setExpanded((prev) => { const next = new Set(prev ?? expanded); path.forEach((id) => next.add(id)); return next; });
    setFocusId(spanId);
    setOpenId(spanId);
  };
  const jump = () => { if (failure && failingSpan) jumpToSpan(failure.spanId, failure.path); };
  const jumpToRecoveredFailure = () => {
    if (!recoveredFailureId) return;
    const path: string[] = [];
    for (let current = byId.get(recoveredFailureId); current; current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined) path.push(current.spanId);
    jumpToSpan(recoveredFailureId, path);
  };

  const onRowKey = (event: React.KeyboardEvent, index: number) => {
    const row = rows[index];
    if (!row) return;
    const id = row.span.spanId;
    switch (event.key) {
      case "ArrowDown": { const n = rows[index + 1]; if (n) focusRow(n.span.spanId); break; }
      case "ArrowUp": { const p = rows[index - 1]; if (p) focusRow(p.span.spanId); break; }
      case "Home": { const f = rows[0]; if (f) focusRow(f.span.spanId); break; }
      case "End": { const l = rows[rows.length - 1]; if (l) focusRow(l.span.spanId); break; }
      case "ArrowRight":
        if (row.hasChildren && !row.expanded) toggle(id, true);
        else if (row.hasChildren) { const c = rows[index + 1]; if (c) focusRow(c.span.spanId); }
        break;
      case "ArrowLeft":
        if (row.hasChildren && row.expanded) toggle(id, false);
        else if (row.span.parentSpanId && byId.has(row.span.parentSpanId)) focusRow(row.span.parentSpanId);
        break;
      case "Enter": case " ": setOpenId(id); break;
      case "Escape": onClose(); break;
      default: return;
    }
    event.preventDefault();
  };

  const closeDrawer = () => { const id = openId; setOpenId(null); if (id) focusRow(id); };
  const openAuditSpan = (spanId: string) => {
    const path: string[] = [];
    for (let current = byId.get(spanId); current; current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined) path.push(current.spanId);
    setFilter(EMPTY_FILTER);
    setExpanded((prev) => { const next = new Set(prev ?? expanded); path.forEach((id) => next.add(id)); return next; });
    setShowAudit(false);
    setOpenId(null);
    setFocusId(spanId);
    setFocusReq((n) => n + 1);
  };

  // Evidence links use the same jump mechanism as the audit table and the first-failure banner:
  // expand the cited span's path, focus its row and open the drawer (#173).
  const openEvidenceEvent = (eventId: string) => {
    const event = view.events.find((item) => item.eventId === eventId);
    if (!event) return;
    const path: string[] = [];
    for (let current = byId.get(event.spanId); current; current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined) path.unshift(current.spanId);
    setFilter(EMPTY_FILTER);
    setExpanded((prev) => { const next = new Set(prev ?? expanded); path.forEach((id) => next.add(id)); return next; });
    setFocusId(event.spanId);
    setOpenId(event.spanId);
  };

  const downloadExport = async () => {
    setExportError(null);
    try {
      const { blob, filename } = await api.exportTrace(summary.traceId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      // #217: revoking on the next tick races the download outside Chrome; a second is safely past it.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section ref={sectionRef} className={"runs-view trace-detail" + (openSpan ? " trace-detail-with-drawer" : "")} aria-labelledby="trace-heading">
      <div className="playground-topbar trace-header">
        <div>
          <span className="eyebrow">Trace · schema {summary.schemaVersion} · {summary.capturePolicy}</span>
          <h2 id="trace-heading">
            <span className={"status status-" + summary.status}><span aria-hidden="true">{STATUS_ICON[summary.status]}</span>{summary.status}</span>{" "}
            {/* #371: runs-list short-id style — full UUID stays hoverable here and in the TRACE field. */}
            Run <code title={summary.runId || runId}>{(summary.runId || runId).slice(0, 8)}</code>
          </h2>
        </div>
        <div className="header-actions">
          {/* #217: a real button — a middle-click or "Save link as" on an <a> bypasses onClick and
              hits the export URL without the bearer token, saving a 401 JSON body. */}
          <button type="button" className="button button-ghost" onClick={() => void downloadExport()}>
            Export JSON
          </button>
          <button type="button" className="button button-ghost" onClick={() => onRerun(runId)}>Re-run prompt</button>
          <button type="button" className="button button-ghost" onClick={openSaveCase} disabled={Boolean(saveReason)} title={saveReason || undefined}>Save as regression case</button>
          {/* #341: a disabled button is unfocusable, so its title never surfaces — say why visibly. */}
          {saveReason && <span className="trace-muted">{saveReason}</span>}
          <button type="button" className="button button-ghost" onClick={onClose}>Close trace</button>
        </div>
      </div>

      {exportError && <p className="trace-export-error" role="alert">Export failed: {exportError}</p>}

      <dl className="trace-summary">
        <Field label="Trace">{summary.traceId || <span className="dash">—</span>}</Field>
        <Field label="Agent">{run?.agentName || summary.agentId || <span className="dash">—</span>}</Field>
        <Field label="Workspace"><span title={workspace.title}>{workspace.text}</span></Field>
        <Field label="Runtime / model" className="trace-runtime"><span title={run ? run.runtime + " · " + run.model : undefined}>{run ? run.runtime + " · " + run.model : <span className="dash">—</span>}</span></Field>
        <Field label="Session">{summary.sessionId ?? <span className="trace-muted">not observed</span>}</Field>
        <Field label="Start">{formatClock(summary.startedAt)}</Field>
        <Field label="Duration">{formatRunDuration(summary.durationMs, summary.endedReason, summary.interruptedAfterMs)}</Field>
        <Field label="Outcome">{summary.outcome?.text ?? (summary.outcome?.reportedFailure ? <span className="badge badge-warn" title={REPORTED_FAILURE_HINT}>agent reported failure</span> : <span className="dash">—</span>)}</Field>
        <Field label="Events">{summary.eventCount} · {summary.spanCount} spans</Field>
        <Field label="Usage">{formatUsage(summary.usage)}</Field>
        <Field label="Metrics">
          {pluralize(summary.metrics.toolCalls, "tool call")} · {summary.metrics.toolFailures} failed · {pluralize(summary.metrics.modelCalls, "model call")}
          {summary.metrics.tokens?.reasoning === undefined ? "" : ` · ${formatReasoningTokens(summary.metrics.tokens)}`}
          {summary.metrics.retries > 0 ? ` · ${pluralize(summary.metrics.retries, "retry", "retries")}` : ""}
          {summary.metrics.denials > 0 ? ` · ${summary.metrics.denials} denied` : ""}
        </Field>
        <Field label="Actors"><span className="trace-muted" title={actors.title}>{actors.text}</span></Field>
        <Field label="Time split">
          model {formatDuration(summary.metrics.timeSplit.modelMs)} · tools {formatDuration(summary.metrics.timeSplit.toolMs)} · start {formatDuration(summary.metrics.timeSplit.containerStartMs)}
          {summary.metrics.timeToFirstToolMs !== undefined ? ` · first tool ${formatDuration(summary.metrics.timeToFirstToolMs)}` : ""}
        </Field>
        <Field label="Config hash">
          <code title={run?.configSnapshot ? JSON.stringify(run.configSnapshot) : undefined}>{summary.configHash ?? run?.configHash ?? <span className="dash">—</span>}</code>
        </Field>
        <Field label="Evidence" className="trace-evidence">
          <CapabilityBadge layer="model" state={summary.capabilities.model} status={summary.status} />
          <CapabilityBadge layer="tool" state={summary.capabilities.tool} status={summary.status} />
          {summary.redactedEvents > 0 && <span className="badge">redacted {summary.redactedEvents}</span>}
          {summary.truncated && <span className="badge badge-warn">truncated</span>}
          {summary.degraded && <span className="badge badge-warn">degraded</span>}
          {summary.incompleteSpans > 0 && <span className="badge badge-warn">{summary.incompleteSpans} incomplete</span>}
          {summary.workspaceChanges && <span className="badge">{summary.workspaceChanges.added + summary.workspaceChanges.modified + summary.workspaceChanges.removed} files changed</span>}
        </Field>
      </dl>

      {failure && (
        <div className="error-banner trace-banner" aria-live="polite">
          <div>
            <strong>{failure.kind === "denied" ? "First denial" : "First actionable " + failure.kind}: {failure.name}</strong>
            {/* #263: the meta line names the origin only; the full error text renders once, in the diagnosis. */}
            <span className="trace-banner-meta" title={failure.message || undefined}>{failure.category} · {failure.component}</span>
            {failure.hint && <span className="badge badge-warn" title="Derived from the stored provider error by a fixed rule — not a judgement.">{failure.hint}</span>}
            {/* #341: the server diagnosis restates the heading's "First actionable <kind>: <name>" clause — trimmed here. */}
            <p id="trace-diagnosis" className="trace-diagnosis">{collapseRequestId(trimDiagnosis(failure.diagnosis, failure))}</p>
          </div>
          {failingSpan && (
            <button type="button" className="button button-primary" onClick={jump} aria-describedby="trace-diagnosis">Jump to failing span</button>
          )}
        </div>
      )}

      {recoveredFailureId && (
        <div className="run-error run-error-slim">
          {pluralize(summary.metrics.toolFailures, "tool failure")} —{" "}
          <button type="button" className="evidence-link" onClick={jumpToRecoveredFailure}>Jump to first</button>
        </div>
      )}

      {evaluations.length > 0 && (
        <section className="trace-evaluations" aria-labelledby="trace-evaluations-heading">
          <h3 id="trace-evaluations-heading">Evaluation</h3>
          <ul>
            {evaluations.map((result) => {
              const meta = metadataParts(result);
              return (
                <li key={evaluatorLabel(result)}>
                  <span className={"badge " + (result.passed ? "badge-pass" : "badge-fail")}>{result.passed ? "PASS" : "FAIL"}</span>
                  <code>{evaluatorLabel(result)}</code>
                  <span className="eval-message">
                    {result.score !== undefined && <span>score {result.score}</span>}
                    {result.explanation && <span className="trace-muted">{result.explanation}</span>}
                    {meta.length > 0 && (
                      <span className="trace-muted eval-meta">
                        {meta.map((part) => <span key={part.text} title={part.title}>{part.text}</span>)}
                      </span>
                    )}
                  </span>
                  <EvidenceLinks ids={result.evidenceEventIds} onOpen={openEvidenceEvent} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="trace-filters" role="group" aria-label="Span filters">
        <label>Category
          <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value as TraceFilter["category"] })}>
            <option value="">all</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Status
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as TraceFilter["status"] })}>
            <option value="">all</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Search
          <input type="search" value={filter.text} placeholder="name, span id, error…" onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
        </label>
        <label className="trace-check">
          <input type="checkbox" checked={filter.errorsOnly} onChange={(e) => setFilter({ ...filter, errorsOnly: e.target.checked })} />
          Errors only
        </label>
        {isFilterActive(filter) && (
          <button type="button" className="button button-ghost" onClick={() => setFilter(EMPTY_FILTER)}>Clear</button>
        )}
        <button
          type="button"
          className="button button-ghost"
          aria-pressed={showAudit}
          onClick={() => setShowAudit((open) => !open)}
        >
          Audit
        </button>
      </div>

      {showAudit ? (
        <AuditTable rows={auditRows} error={auditError} onOpenSpan={openAuditSpan} />
      ) : (
        <>
      {ticks.length > 0 && (
        <div className="trace-axis" aria-hidden="true">
          <span className="trace-axis-title">Timeline</span>
          <span className="trace-axis-scale">
            {ticks.map((tick, index) => (
              <span
                key={tick.milliseconds}
                className={"trace-axis-tick" + (index === 0 ? " first" : index === ticks.length - 1 ? " last" : "")}
                style={{ left: tick.percent + "%" }}
              >
                <span>{formatDuration(tick.milliseconds)}</span>
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="trace-tree" role="tree" aria-label="Spans">
        {rows.map((row, index) => {
          const s = row.span;
          const geo = barGeometry(s, view, s.parentSpanId ? byId.get(s.parentSpanId) : undefined);
          const timingDescription = geo
            ? `${s.name}: starts ${formatDuration(geo.startOffsetMs)} after Run start; ${geo.instant ? "instant event" : `duration ${formatDuration(geo.durationMs)}`}${geo.openEnded ? "; incomplete and open-ended" : ""}${geo.endsAfterParent ? "; ends after parent" : ""}.`
            : undefined;
          const timingId = `span-timing-${s.spanId}`;
          const failing = failure?.spanId === s.spanId;
          const statusLabel = spanStatusLabel(s, summary);
          // #341/#368: a never-closed or interrupted span in a dead Run is a warning, not
          // activity — amber for both the pill and the bar fill, never RUNNING-blue.
          const fillStatus = spanFillStatus(statusLabel, s.status);
          const statusClass = "status-" + fillStatus;
          const argument = spanArgument(s.attributes);
          return (
            <div
              key={s.spanId}
              ref={(el) => { if (el) rowRefs.current.set(s.spanId, el); else rowRefs.current.delete(s.spanId); }}
              role="treeitem"
              aria-level={s.depth + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={openId === s.spanId}
              aria-describedby={timingDescription ? timingId : undefined}
              tabIndex={rovingId === s.spanId ? 0 : -1}
              className={"trace-row" + (failing ? " failing" : "") + (row.context ? " context" : "") + (openId === s.spanId ? " selected" : "")}
              style={{ "--trace-indent": `${s.depth * 18}px` } as React.CSSProperties}
              onClick={() => { setFocusId(s.spanId); setOpenId(s.spanId); }}
              onKeyDown={(e) => onRowKey(e, index)}
            >
              <button
                type="button"
                tabIndex={-1}
                className="trace-caret"
                aria-hidden="true"
                disabled={!row.hasChildren}
                onClick={(e) => { e.stopPropagation(); toggle(s.spanId, !row.expanded); }}
              >
                {row.hasChildren ? (row.expanded ? "▾" : "▸") : "·"}
              </button>
              <span className={"status " + statusClass}><span aria-hidden="true">{STATUS_ICON[s.status]}</span>{statusLabel}</span>
              <span className="trace-name" title={[[s.attributes.program, s.attributes.argument0].filter((value) => typeof value === "string" && value.length > 0).join(" "), s.error?.message].filter(Boolean).join("\n") || undefined}>
                {s.name}
                {/* #341: argument0 discriminates otherwise-identical tool rows (16× "shell:powershell.exe"). */}
                {argument && <span className="trace-muted"> {argument}</span>}
                {/* #263: error subtitle is a truncated head; the full text stays in the row's title tooltip. */}
                {s.error?.message && <span className="trace-error-head"> — {errorHead(s.error.message)}</span>}
              </span>
              <span className="trace-cat">{s.category}</span>
              <span className="trace-badges">
                {(row.repeat ?? 1) > 1 && <span className="badge" title={`repeated ${row.repeat} times — identical repeats collapsed`}>×{row.repeat}</span>}
                {s.incomplete && <span className="badge badge-warn">incomplete</span>}
                {!s.source.observed && <span className="badge">unavailable</span>}
                {redactedSpans.has(s.spanId) && <span className="badge badge-redacted">redacted</span>}
              </span>
              <span className="trace-bar" title={timingDescription} aria-hidden="true">
                {geo?.instant && <span className={"trace-bar-marker fill-" + fillStatus} style={{ left: geo.left + "%" }} />}
                {geo && !geo.instant && (
                  <span
                    className={"trace-bar-fill fill-" + fillStatus + (geo.openEnded ? " open-ended" : "")}
                    style={{ left: geo.left + "%", width: geo.width + "%" }}
                  />
                )}
              </span>
              <span className="trace-dur">{geo?.instant ? <span className="dash">instant</span> : formatDuration(s.durationMs)}</span>
              {timingDescription && <span id={timingId} className="sr-only">{timingDescription}</span>}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="runs-empty">{view.spans.length === 0 ? "No spans observed yet." : "No spans match these filters."}</p>
        )}
      </div>
        </>
      )}

      {!showAudit && (
        <>
          <details className="trace-logs">
            <summary>Logs · {logs.length}{logsTruncated ? "+" : ""}</summary>
            <label>Level
              <select value={logLevel} onChange={(event) => setLogLevel(event.target.value)}>
                <option value="">all</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </label>
            {logs.length === 0 ? <p className="runs-empty">No log lines carry this Run&apos;s id.</p> : (
              <ol className="run-logs">
                {logs.map((line, index) => (
                  <li key={line.time + ":" + index} className={line.level === "error" ? "log-error" : line.level === "warn" ? "log-warn" : undefined}>
                    <time>{formatClock(line.time)}</time> <strong>{line.level}</strong>{" "}
                    {line.spanId && byId.has(line.spanId) ? <button type="button" className="evidence-link" onClick={() => focusRow(line.spanId!)}>{line.msg}</button> : <span>{line.msg}</span>}
                    {line.err && <small>{line.err}</small>}
                  </li>
                ))}
              </ol>
            )}
          </details>

          {openSpan && <SpanDrawer span={openSpan} view={view} parentName={openSpan.parentSpanId ? byId.get(openSpan.parentSpanId)?.name : undefined} onClose={closeDrawer} />}
        </>
      )}
      {showSaveCase && (
        <div className="modal-backdrop" onMouseDown={() => !savingCase && setShowSaveCase(false)}>
          <form ref={saveCaseRef} className="modal regression-case-modal" role="dialog" aria-modal="true" aria-labelledby="save-case-title" onSubmit={saveCase} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onSaveCaseKeyDown}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Regression case</span>
                <h2 id="save-case-title">Save successful Run</h2>
                <p>These checks were inferred from the trace evidence. Uncheck any that should not become a stable expectation.</p>
              </div>
              <button type="button" onClick={() => setShowSaveCase(false)} disabled={savingCase} aria-label="Close save regression case">×</button>
            </div>
            <label>
              Name
              <input autoFocus value={caseName} onChange={(event) => setCaseName(event.target.value)} maxLength={120} required />
            </label>
            <div className="assertion-list" aria-label="Prefilled assertions">
              {caseAssertions.length === 0 && !caseError && <p className="trace-muted">Deriving checks from the trace…</p>}
              {caseAssertions.map((assertion, index) => (
                <div key={assertionLabel(assertion) + index}>
                  <label className="trace-check">
                    <input
                      type="checkbox"
                      checked={!excludedChecks.has(index)}
                      disabled={savingCase}
                      aria-label={"Include check: " + assertionLabel(assertion)}
                      onChange={(event) => setExcludedChecks((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.delete(index); else next.add(index);
                        return next;
                      })}
                    />
                    <code>{assertionLabel(assertion)}</code>
                  </label>
                </div>
              ))}
            </div>
            {caseError && <div className="error-banner" role="alert">{caseError}</div>}
            {includedAssertions.length === 0 && <p className="form-help" role="status">Include at least one check — a case with no checks cannot assert anything.</p>}
            <div className="modal-footer">
              <button type="button" className="button button-ghost" onClick={() => setShowSaveCase(false)} disabled={savingCase}>Cancel</button>
              <button className="button button-primary" disabled={savingCase || !caseName.trim() || includedAssertions.length === 0}>{savingCase ? "Saving…" : "Save regression case"}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

/** #346: evaluation rows can carry 14–25 evidence links; show the first few and expand on demand. */
const EVIDENCE_PREVIEW = 3;

function EvidenceLinks({ ids, onOpen }: { ids: string[]; onOpen: (eventId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (ids.length === 0) return null;
  const visible = expanded ? ids : ids.slice(0, EVIDENCE_PREVIEW);
  return (
    <span className="eval-evidence">
      {visible.map((eventId, index) => (
        <button key={eventId} type="button" className="evidence-link" onClick={() => onOpen(eventId)}>
          evidence{ids.length > 1 ? " " + (index + 1) : ""}
        </button>
      ))}
      {ids.length > EVIDENCE_PREVIEW && (
        <button type="button" className="evidence-link evidence-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "show fewer" : `+${ids.length - EVIDENCE_PREVIEW} more`}
        </button>
      )}
    </span>
  );
}

function assertionLabel(assertion: Assertion): string {
  switch (assertion.type) {
    case "terminal_status": return "terminal status is " + assertion.expected;
    case "expected_tool": return "uses " + assertion.program;
    case "max_tool_calls": return "at most " + assertion.max + " tool calls";
    case "max_duration_ms": return "finishes within " + formatDuration(assertion.max);
    case "post_check": return "post-check: " + assertion.command;
  }
}

function AuditTable({ rows, error, onOpenSpan }: { rows: AuditRow[] | null; error: string | null; onOpenSpan: (spanId: string) => void }) {
  if (error) return <p className="runs-empty" role="alert">Audit could not be loaded: {error}</p>;
  if (!rows) return <p className="runs-empty" aria-live="polite">Loading audit…</p>;
  if (rows.length === 0) return <p className="runs-empty">No audit-relevant events for this Run.</p>;
  return (
    <div className="runs-table-wrap audit-table-wrap">
      <table className="runs-table audit-table">
        <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Resource</th><th scope="col">Outcome</th></tr></thead>
        <tbody>{rows.map((row) => (
          // #341: every tool call doubles into started+completed rows — mute the .started half so the
          // consequential row carries the table. Future work: merge each pair into one row.
          <tr key={row.eventId} tabIndex={0} className={row.action.endsWith(".started") ? "trace-muted" : undefined} onClick={() => onOpenSpan(row.spanId)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenSpan(row.spanId); }
          }} aria-label={`Open evidence for ${row.action} by ${row.actor.type}/${row.actor.id}`}>
            <td>{formatClock(row.at)}</td>
            <td title={formatAuditActor(row.actor).title}>{formatAuditActor(row.actor).text}</td>
            <td><button type="button" className="audit-evidence" onClick={(event) => { event.stopPropagation(); onOpenSpan(row.spanId); }}>{row.action}</button></td>
            <td>{row.resource}</td>
            <td><span className={"badge audit-outcome" + (row.outcome === "denied" || row.outcome === "error" ? " badge-error" : "")}>{row.outcome}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Dialog keyboard contract shared by the span drawer and the save-case modal: autofocus, Tab cycles inside, Escape closes.
 *  A `[data-autofocus]` element (e.g. a tabindex=-1 heading) wins the initial focus so a screen reader announces the title first (#103). */
function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onClose: () => void, focusKey: string) {
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[data-autofocus], " + FOCUSABLE)?.focus(); }, [ref, focusKey]);
  return (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    // Shift+Tab from the first item, or from a non-tabbable autofocus target ahead of it, wraps to the last item.
    if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
}

function SpanDrawer({ span, view, parentName, onClose }: { span: Span; view: TraceView; parentName: string | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const events = useMemo(() => view.events.filter((e) => e.spanId === span.spanId), [view, span]);
  const attempt = events[0]?.attempt;
  const shown = events.slice(0, DRAWER_EVENT_CAP);
  const workspaceChange = view.events.find((event) => event.type === "workspace.changed" && event.parentSpanId === span.spanId);
  const interruptedDuration = interruptedSpanDurationMs(span, view.summary);
  const identity = [span.attributes.program, span.attributes.argument0]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");

  const onKeyDown = useFocusTrap(ref, onClose, span.spanId);
  // Docked (static) mode can render the drawer far below the clicked row; bring it into view on open.
  // Harmless no-op when the drawer is a fixed overlay or already visible.
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, [span.spanId]);

  return (
    <div ref={ref} className="span-drawer" role="dialog" aria-modal="true" aria-labelledby="span-drawer-title" onKeyDown={onKeyDown}>
      <div className="span-drawer-head">
        <div>
          <span className="eyebrow">Span · {span.category}</span>
          <h3 id="span-drawer-title" tabIndex={-1} data-autofocus>{identity || span.name}</h3>
        </div>
        <button type="button" className="button button-ghost" onClick={onClose} aria-label="Close span details">×</button>
      </div>
      <dl className="trace-summary">
        <Field label="Status">
          <span className={"status status-" + span.status}><span aria-hidden="true">{STATUS_ICON[span.status]}</span>{view.summary.endedReason === "server_restart" && span.incomplete ? "interrupted by server restart (never closed)" : span.status}</span>
          {span.incomplete && <span className="badge badge-warn">incomplete</span>}
        </Field>
        <Field label="Span id">{span.spanId}</Field>
        <Field label="Parent">{parentName ?? span.parentSpanId ?? <><span className="dash">—</span> (root)</>}</Field>
        <Field label="Source">{span.source.component}{span.source.adapter ? " / " + span.source.adapter : ""} <span className="badge">{span.source.observed ? "observed" : "unavailable"}</span></Field>
        {/* #341: local clock like the event rows below — the raw ISO UTC stamp stays in the title. */}
        <Field label="Started"><span title={span.startedAt}>{formatClock(span.startedAt)}</span></Field>
        <Field label="Ended">{interruptedDuration !== undefined ? `never closed — server restarted at ${formatClock(view.summary.endedAt)}` : span.endedAt ? <span title={span.endedAt}>{formatClock(span.endedAt)}</span> : <span className="dash">—</span>}</Field>
        <Field label="Duration">{interruptedDuration !== undefined ? `≥ ${formatDuration(interruptedDuration)}` : span.durationMs === 0 && !span.incomplete ? "instant" : formatDuration(span.durationMs)}</Field>
        <Field label="Attempt">{attempt ?? <span className="dash">—</span>}</Field>
        <Field label="Sequence">{span.sequence}</Field>
      </dl>

      {span.error && (
        <div className="error-banner span-error">
          <span><strong>{span.error.type}</strong> — {span.error.message}</span>
        </div>
      )}

      {span.summary && (
        <>
          <h4>Safe summary <span className="badge">{span.summary.policy}</span></h4>
          <p className="span-summary">{span.summary.text}</p>
        </>
      )}

      {workspaceChange && (
        <>
          <h4>Changed paths</h4>
          <pre className="span-summary">{String(workspaceChange.attributes.paths || "No paths changed")}</pre>
        </>
      )}

      <h4>Attributes</h4>
      {Object.keys(span.attributes).length === 0 ? <p className="runs-empty">None recorded.</p> : (
        <dl className="span-attrs">
          {Object.entries(span.attributes).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{formatAttribute(v)}</dd></div>
          ))}
        </dl>
      )}

      <h4>Events {events.length > DRAWER_EVENT_CAP && <span className="trace-count">showing {shown.length} of {events.length}</span>}</h4>
      {shown.length === 0 ? <p className="runs-empty">No events recorded for this span.</p> : (
        <ol className="span-events">
          {shown.map((e) => <EventRow key={e.eventId} event={e} />)}
        </ol>
      )}
    </div>
  );
}

function EventRow({ event: e }: { event: ObservationEvent }) {
  // A start event's stored "running" status is a historical fact, not a live state — render it as a neutral "started" pill.
  const started = e.phase === "start" && e.status === "running";
  return (
    <li>
      <span className="trace-count">#{e.sequence}</span>
      {started
        ? <span className="status status-started"><span aria-hidden="true">·</span>started</span>
        : <span className={"status status-" + e.status}><span aria-hidden="true">{STATUS_ICON[e.status]}</span>{e.status}</span>}
      <span className="trace-name">{e.type}</span>
      <span className="trace-cat">{e.phase}</span>
      <span className="trace-badges">
        {e.privacy.redacted && <span className="badge badge-redacted">redacted</span>}
        {!e.source.observed && <span className="badge">unavailable</span>}
      </span>
      <span className="trace-dur">{formatClock(e.timestamp)}</span>
      {e.error && <span className="span-event-error">{e.error.type}: {e.error.message}</span>}
    </li>
  );
}
