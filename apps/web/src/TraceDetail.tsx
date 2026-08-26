import { useEffect, useMemo, useRef, useState } from "react";
import type { ObservationEvent, RunListItem, Span, TraceView } from "./types";
import { STATUS_ICON, formatClock, formatDuration, formatUsage } from "./runs-view-model";
import {
  CATEGORIES,
  DRAWER_EVENT_CAP,
  EMPTY_FILTER,
  STATUSES,
  barGeometry,
  defaultExpanded,
  formatAttribute,
  indexSpans,
  isFilterActive,
  visibleRows,
  type TraceFilter,
} from "./trace-view-model";

// Three capability states (PRD §8): observed | unavailable | unknown. "unknown" = the Run was cut short
// before the stream said anything; it is not a capability gap. Short badge copy; long form in `title`.
const CAPABILITY_LABEL = { observed: "observed", unavailable: "unavailable", unknown: "no evidence — run cut short" } as const;
const CAPABILITY_TITLE = {
  observed: "The runtime emitted events for this layer.",
  unavailable: "The Run completed but the runtime exposed no events for this layer.",
  unknown: "The Run was cancelled or timed out before the stream said anything about this layer; absence proves nothing.",
} as const;

function CapabilityBadge({ layer, state }: { layer: "model" | "tool"; state: keyof typeof CAPABILITY_LABEL }) {
  return <span className="badge" title={layer + ": " + CAPABILITY_TITLE[state]}>{layer} {CAPABILITY_LABEL[state]}</span>;
}

interface Props {
  runId: string;
  /** Runs-list row for this Run (agent name, runtime, model live there, not on TraceSummary). */
  run: RunListItem | undefined;
  view: TraceView | null;
  onClose: () => void;
}

// Trace detail (UX-02): summary header, first-error banner with Jump, nested tree with duration bars,
// client-side filters, focus-trapped span drawer. Everything shown comes straight from the API payload.
export default function TraceDetail({ runId, run, view, onClose }: Props) {
  const [filter, setFilter] = useState<TraceFilter>(EMPTY_FILTER);
  // null = untouched → follow the API's default (roots + failure path) even as the trace grows while polling.
  const [expandedState, setExpanded] = useState<Set<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Bumped whenever focus must move programmatically (keyboard nav, Jump, drawer close); the effect below
  // runs after the target row has rendered, which matters when Jump expands a collapsed path.
  const [focusReq, setFocusReq] = useState(0);
  // Once per open (App keys this component by runId): bring the header + banner into the first viewport.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => { sectionRef.current?.scrollIntoView({ block: "start" }); }, []);

  const byId = useMemo(() => (view ? indexSpans(view.spans) : new Map<string, Span>()), [view]);
  // Per-row redaction comes from the full event list: the server only nests intermediate events under
  // `span.events`, and redaction usually lands on the span's own start/end event.
  const redactedSpans = useMemo(() => new Set(view?.events.filter((e) => e.privacy.redacted).map((e) => e.spanId)), [view]);
  const expanded = useMemo(() => expandedState ?? (view ? defaultExpanded(view) : new Set<string>()), [expandedState, view]);
  const rows = useMemo(() => (view ? visibleRows(view.spans, expanded, filter) : []), [view, expanded, filter]);
  const rovingId = focusId && rows.some((r) => r.span.spanId === focusId) ? focusId : (rows[0]?.span.spanId ?? null);

  useEffect(() => {
    if (focusReq > 0 && rovingId) rowRefs.current.get(rovingId)?.focus();
  }, [focusReq]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const failingSpan = failure && byId.get(failure.spanId);
  const openSpan = openId ? byId.get(openId) : undefined;

  const focusRow = (id: string) => { setFocusId(id); setFocusReq((n) => n + 1); };
  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => { const next = new Set(prev ?? expanded); if (open) next.add(id); else next.delete(id); return next; });

  const jump = () => {
    if (!failure || !failingSpan) return;
    setFilter(EMPTY_FILTER);
    setExpanded((prev) => { const next = new Set(prev ?? expanded); failure.path.forEach((id) => next.add(id)); return next; });
    // Open the drawer too: row click → Jump lands on status/duration/error/summary in 2 interactions (PRD §64).
    // The drawer's own focus effect takes focus; closeDrawer hands it back to this row.
    setFocusId(failure.spanId);
    setOpenId(failure.spanId);
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
      default: return;
    }
    event.preventDefault();
  };

  const closeDrawer = () => { const id = openId; setOpenId(null); if (id) focusRow(id); };

  return (
    <section ref={sectionRef} className="runs-view trace-detail" aria-labelledby="trace-heading">
      <div className="playground-topbar trace-header">
        <div>
          <span className="eyebrow">Trace · schema {summary.schemaVersion} · {summary.capturePolicy}</span>
          <h2 id="trace-heading">
            <span className={"status status-" + summary.status}><span aria-hidden="true">{STATUS_ICON[summary.status]}</span>{summary.status}</span>{" "}
            <code>{summary.runId || runId}</code>
          </h2>
        </div>
        <button type="button" className="button button-ghost" onClick={onClose}>Close trace</button>
      </div>

      <dl className="trace-summary">
        <Field label="Trace">{summary.traceId || "—"}</Field>
        <Field label="Agent">{run?.agentName || summary.agentId || "—"}</Field>
        <Field label="Runtime / model">{run ? run.runtime + " · " + run.model : "—"}</Field>
        <Field label="Session">{summary.sessionId ?? "—"}</Field>
        <Field label="Start">{formatClock(summary.startedAt)}</Field>
        <Field label="Duration">{formatDuration(summary.durationMs)}</Field>
        <Field label="Events">{summary.eventCount} · {summary.spanCount} spans</Field>
        <Field label="Usage">{formatUsage(summary.usage)}</Field>
        <Field label="Trust">
          <CapabilityBadge layer="model" state={summary.capabilities.model} />
          <CapabilityBadge layer="tool" state={summary.capabilities.tool} />
          {summary.redactedEvents > 0 && <span className="badge">redacted {summary.redactedEvents}</span>}
          {summary.truncated && <span className="badge badge-warn">truncated</span>}
          {summary.degraded && <span className="badge badge-warn">degraded</span>}
          {summary.incompleteSpans > 0 && <span className="badge badge-warn">{summary.incompleteSpans} incomplete</span>}
        </Field>
      </dl>

      {failure && (
        <div className="error-banner trace-banner" aria-live="polite">
          <div>
            <strong>First actionable {failure.kind}: {failure.name}</strong>
            <span className="trace-banner-meta">{failure.category} · {failure.component}{failure.message ? " · " + failure.message : ""}</span>
            <p className="trace-diagnosis">{failure.diagnosis}</p>
          </div>
          {failingSpan && (
            <button type="button" className="button button-primary" onClick={jump} autoFocus>Jump to failing span</button>
          )}
        </div>
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
          errors only
        </label>
        {isFilterActive(filter) && (
          <button type="button" className="button button-ghost" onClick={() => setFilter(EMPTY_FILTER)}>Clear</button>
        )}
      </div>

      <div className="trace-tree" role="tree" aria-label="Spans">
        {rows.map((row, index) => {
          const s = row.span;
          const geo = barGeometry(s, view);
          const failing = failure?.spanId === s.spanId;
          return (
            <div
              key={s.spanId}
              ref={(el) => { if (el) rowRefs.current.set(s.spanId, el); else rowRefs.current.delete(s.spanId); }}
              role="treeitem"
              aria-level={s.depth + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={openId === s.spanId}
              tabIndex={rovingId === s.spanId ? 0 : -1}
              className={"trace-row" + (failing ? " failing" : "") + (row.context ? " context" : "") + (openId === s.spanId ? " selected" : "")}
              style={{ paddingLeft: 12 + s.depth * 18 }}
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
              <span className={"status status-" + s.status}><span aria-hidden="true">{STATUS_ICON[s.status]}</span>{s.status}</span>
              <span className="trace-name">{s.name}</span>
              <span className="trace-cat">{s.category}</span>
              <span className="trace-badges">
                {s.incomplete && <span className="badge badge-warn">incomplete</span>}
                {!s.source.observed && <span className="badge">unavailable</span>}
                {redactedSpans.has(s.spanId) && <span className="badge">redacted</span>}
              </span>
              <span className="trace-bar" aria-hidden="true">
                {geo && <span className={"trace-bar-fill fill-" + s.status} style={{ left: geo.left + "%", width: geo.width + "%" }} />}
              </span>
              <span className="trace-dur">{formatDuration(s.durationMs)}</span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="runs-empty">{view.spans.length === 0 ? "No spans observed yet." : "No spans match these filters."}</p>
        )}
      </div>

      {openSpan && <SpanDrawer span={openSpan} view={view} parentName={openSpan.parentSpanId ? byId.get(openSpan.parentSpanId)?.name : undefined} onClose={closeDrawer} />}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function SpanDrawer({ span, view, parentName, onClose }: { span: Span; view: TraceView; parentName: string | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const events = useMemo(() => view.events.filter((e) => e.spanId === span.spanId), [view, span]);
  const attempt = events[0]?.attempt;
  const shown = events.slice(0, DRAWER_EVENT_CAP);

  useEffect(() => { ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(); }, [span.spanId]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div ref={ref} className="span-drawer" role="dialog" aria-modal="true" aria-labelledby="span-drawer-title" onKeyDown={onKeyDown}>
      <div className="span-drawer-head">
        <div>
          <span className="eyebrow">Span · {span.category}</span>
          <h3 id="span-drawer-title">{span.name}</h3>
        </div>
        <button type="button" className="button button-ghost" onClick={onClose} aria-label="Close span details">×</button>
      </div>
      <dl className="trace-summary">
        <Field label="Status">
          <span className={"status status-" + span.status}><span aria-hidden="true">{STATUS_ICON[span.status]}</span>{span.status}</span>
          {span.incomplete && <span className="badge badge-warn">incomplete</span>}
        </Field>
        <Field label="Span id">{span.spanId}</Field>
        <Field label="Parent">{parentName ?? span.parentSpanId ?? "— (root)"}</Field>
        <Field label="Source">{span.source.component}{span.source.adapter ? " / " + span.source.adapter : ""} <span className="badge">{span.source.observed ? "observed" : "unavailable"}</span></Field>
        <Field label="Started">{span.startedAt}</Field>
        <Field label="Ended">{span.endedAt ?? "—"}</Field>
        <Field label="Duration">{formatDuration(span.durationMs)}</Field>
        <Field label="Attempt">{attempt ?? "—"}</Field>
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

      <h4>Attributes</h4>
      {Object.keys(span.attributes).length === 0 ? <p className="runs-empty">None recorded.</p> : (
        <dl className="span-attrs">
          {Object.entries(span.attributes).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{formatAttribute(v)}</dd></div>
          ))}
        </dl>
      )}

      <h4>Events <span className="trace-count">showing {shown.length} of {events.length}</span></h4>
      {shown.length === 0 ? <p className="runs-empty">No events recorded for this span.</p> : (
        <ol className="span-events">
          {shown.map((e) => <EventRow key={e.eventId} event={e} />)}
        </ol>
      )}
    </div>
  );
}

function EventRow({ event: e }: { event: ObservationEvent }) {
  return (
    <li>
      <span className="trace-count">#{e.sequence}</span>
      <span className={"status status-" + e.status}><span aria-hidden="true">{STATUS_ICON[e.status]}</span>{e.status}</span>
      <span className="trace-name">{e.type}</span>
      <span className="trace-cat">{e.phase}</span>
      <span className="trace-badges">
        {e.privacy.redacted && <span className="badge">redacted</span>}
        {!e.source.observed && <span className="badge">unavailable</span>}
      </span>
      <span className="trace-dur">{formatClock(e.timestamp)}</span>
      {e.error && <span className="span-event-error">{e.error.type}: {e.error.message}</span>}
    </li>
  );
}
