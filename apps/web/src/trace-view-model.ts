import type { Category, Span, TraceStatus, TraceView } from "./types";
import { formatCount } from "./runs-view-model";

// Pure helpers for TraceDetail. Render only what the API returned — error path, diagnosis and
// every flag come from `TraceView`; nothing here infers status or failure on its own.

export interface TraceFilter {
  category: Category | "";
  status: TraceStatus | "";
  text: string;
  errorsOnly: boolean;
}

export const EMPTY_FILTER: TraceFilter = { category: "", status: "", text: "", errorsOnly: false };

export const CATEGORIES: Category[] = [
  "experience", "control", "runtime", "model", "tool", "workspace", "sandbox", "policy", "infrastructure",
];
export const STATUSES: TraceStatus[] = ["running", "ok", "error", "cancelled", "timeout", "unset"];

export const DRAWER_EVENT_CAP = 200;

export function formatReasoningTokens(tokens: TraceView["summary"]["metrics"]["tokens"]): string {
  return tokens?.reasoning === undefined ? "" : `${formatCount(tokens.reasoning)} reasoning tokens`;
}

export const ACTORS_TOOLTIP = "Every consequential event attributed to who did it — see the Audit table for the rows.";

/** ponytail: fixed display cap, no measuring — the full list always lives in the title. */
const ACTOR_DISPLAY_LIMIT = 4;

/** One summary-row line for `summary.audit` (#250): actors joined, capped, denial count appended. */
export function formatActors(audit: TraceView["summary"]["audit"]): { text: string; title: string } {
  const truncated = audit.actors.length > ACTOR_DISPLAY_LIMIT;
  const shown = truncated ? audit.actors.slice(0, ACTOR_DISPLAY_LIMIT).join(" · ") + " · …" : audit.actors.join(" · ");
  const denied = audit.denials > 0 ? ` · ${audit.denials} denied` : "";
  return {
    text: (shown || "—") + denied,
    title: truncated ? `${ACTORS_TOOLTIP} All actors: ${audit.actors.join(" · ")}` : ACTORS_TOOLTIP,
  };
}

/** Audit ACTOR cell (#338): `kind · shortId` so a ~40-char id isn't repeated on every row; full id lives in the title. */
export function formatAuditActor(actor: { type: string; id: string }): { text: string; title: string } {
  const shortId = actor.id.length > 10 ? actor.id.slice(0, 8) + "…" : actor.id;
  return { text: `${actor.type} · ${shortId}`, title: `${actor.type}/${actor.id}` };
}

export function refreshIntervalMs(status: TraceStatus | undefined): number {
  return status === "running" ? 1_500 : 5_000;
}

export function capabilityCopy(
  state: "observed" | "unavailable" | "unknown",
  runStatus: TraceStatus,
): { label: string; title: string } {
  if (state === "observed") {
    return { label: "observed", title: "The runtime emitted events for this layer." };
  }
  if (state === "unavailable") {
    return { label: "unavailable", title: "The Run completed but the runtime exposed no events for this layer." };
  }
  if (runStatus === "running") {
    return { label: "pending", title: "The Run is still in progress; capability evidence may arrive on a later refresh." };
  }
  return {
    label: "no evidence",
    // Reachable on an ok Run too: the observer only declares `unavailable` when *both* layers are unseen (#182 marks the model on every turn).
    title: "The Run ended without any events for this layer and the runtime declared nothing about it; absence proves nothing.",
  };
}

export function capabilityBadgeLabel(
  layer: "model" | "tool",
  state: "observed" | "unavailable" | "unknown",
  runStatus: TraceStatus,
): string {
  const copy = capabilityCopy(state, runStatus);
  return layer + (state === "unknown" && runStatus !== "running" ? ": " : " ") + copy.label;
}

export function spanStatusLabel(span: Pick<Span, "status" | "incomplete">, endedReason?: "server_restart"): string {
  return endedReason === "server_restart" && span.incomplete ? "interrupted" : span.status;
}

export function interruptedSpanDurationMs(span: Pick<Span, "startedAt" | "incomplete">, summary: TraceView["summary"]): number | undefined {
  if (!span.incomplete || summary.endedReason !== "server_restart" || !summary.startedAt || summary.interruptedAfterMs === undefined) return undefined;
  const start = Date.parse(span.startedAt);
  const bound = Date.parse(summary.startedAt) + summary.interruptedAfterMs; // summary.endedAt is the next boot, not the cut
  return Number.isNaN(start) || Number.isNaN(bound) ? undefined : Math.max(0, bound - start);
}

export function isFilterActive(f: TraceFilter): boolean {
  return f.category !== "" || f.status !== "" || f.text.trim() !== "" || f.errorsOnly;
}

export function isFailed(status: TraceStatus): boolean {
  return status === "error" || status === "timeout" || status === "cancelled";
}

/** First span in document order that failed or carries an error — anchor for the ok-Run tool-failure banner. */
export function firstFailedSpanId(spans: Span[]): string | undefined {
  for (const span of spans) {
    if (isFailed(span.status) || span.error) return span.spanId;
    const child = firstFailedSpanId(span.children);
    if (child) return child;
  }
  return undefined;
}

export function matchesSpan(span: Span, f: TraceFilter): boolean {
  if (f.category && span.category !== f.category) return false;
  if (f.status && span.status !== f.status) return false;
  if (f.errorsOnly && !isFailed(span.status) && !span.error) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  const hay = [span.name, span.spanId, span.category, span.source.component, span.error?.type, span.error?.message]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

export function indexSpans(spans: Span[]): Map<string, Span> {
  const out = new Map<string, Span>();
  const walk = (s: Span) => { out.set(s.spanId, s); s.children.forEach(walk); };
  spans.forEach(walk);
  return out;
}

/** Default expansion: all spans for a small trace, otherwise roots plus the failure path. */
export function defaultExpanded(view: TraceView): Set<string> {
  if (view.summary.spanCount <= 40) return new Set(indexSpans(view.spans).keys());
  const set = new Set(view.spans.map((s) => s.spanId));
  for (const id of view.summary.failure?.path ?? []) set.add(id);
  return set;
}

export interface VisibleRow {
  span: Span;
  hasChildren: boolean;
  expanded: boolean;
  /** Ancestor kept only so a filtered match stays in context. */
  context: boolean;
  /** Errors-only view (#338): how many consecutive identical error rows this row stands for (absent = 1). */
  repeat?: number;
}

/**
 * Errors-only view (#338): collapse a run of consecutive identical leaf error rows (same name, depth and
 * error message) into one row carrying a repeat count. Parents are never collapsed — their children rows
 * would be orphaned in the flattened list.
 */
export function coalesceErrorRows(rows: VisibleRow[]): VisibleRow[] {
  const out: VisibleRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const message = row.span.error?.message;
    if (
      prev && message !== undefined && !row.hasChildren && !prev.hasChildren &&
      prev.span.error?.message === message && prev.span.name === row.span.name && prev.span.depth === row.span.depth
    ) {
      out[out.length - 1] = { ...prev, repeat: (prev.repeat ?? 1) + 1 };
    } else {
      out.push(row);
    }
  }
  return out;
}

/**
 * Flatten the tree into the rows that should be in the DOM. Collapsed subtrees are omitted entirely
 * (that is the size bound for a 500-event trace). With an active filter, matches and their ancestors are
 * shown and every kept ancestor is auto-expanded so results are never hidden behind a collapsed node.
 * ponytail: DOM is bounded by span count, not event count — one expanded parent still renders all its
 * children; add a per-parent "show N more" cutoff if a single span ever fans out past a few hundred.
 */
export function visibleRows(spans: Span[], expanded: Set<string>, filter: TraceFilter): VisibleRow[] {
  const active = isFilterActive(filter);
  const keep = new Map<string, boolean>(); // spanId -> subtree has a match
  const mark = (s: Span): boolean => {
    let any = matchesSpan(s, filter);
    for (const c of s.children) if (mark(c)) any = true;
    keep.set(s.spanId, any);
    return any;
  };
  if (active) spans.forEach(mark);

  const out: VisibleRow[] = [];
  const walk = (s: Span) => {
    if (active && !keep.get(s.spanId)) return;
    // ponytail: filters auto-expand every kept ancestor; manual collapse is ignored while a filter is on.
    const open = active || expanded.has(s.spanId);
    out.push({ span: s, hasChildren: s.children.length > 0, expanded: open, context: active && !matchesSpan(s, filter) });
    if (open) s.children.forEach(walk);
  };
  spans.forEach(walk);
  return out;
}

export interface TimelineTick {
  milliseconds: number;
  percent: number;
}

/** Four to six human-scale ticks, always including the exact Run end. */
export function timelineTicks(total: number | undefined): TimelineTick[] {
  if (!total || !Number.isFinite(total) || total <= 0) return [];
  const rawStep = total / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  const values: number[] = [];
  // The last tick's label is right-anchored while interior labels are centered, so an interior tick past
  // ~92% of the track lands under it (≈48px on a typical axis width); drop it rather than overlap.
  for (let value = 0; value < total * 0.92; value += step) values.push(value);
  values.push(total);
  return values.map((milliseconds) => ({ milliseconds, percent: (milliseconds / total) * 100 }));
}

export interface BarGeometry {
  left: number;
  width: number;
  startOffsetMs: number;
  durationMs: number | undefined;
  instant: boolean;
  openEnded: boolean;
  endsAfterParent: boolean;
}

function observedEnd(span: Span): number | undefined {
  const explicit = span.endedAt ? Date.parse(span.endedAt) : NaN;
  if (!Number.isNaN(explicit)) return explicit;
  const start = Date.parse(span.startedAt);
  return Number.isNaN(start) || span.durationMs === undefined ? undefined : start + span.durationMs;
}

/** Bar geometry as percentages of the Run duration; undefined when the timeline is unusable. */
export function barGeometry(span: Span, view: TraceView, parent?: Span): BarGeometry | undefined {
  const total = view.summary.durationMs;
  const start = view.summary.startedAt ? Date.parse(view.summary.startedAt) : NaN;
  const spanStart = Date.parse(span.startedAt);
  if (!total || !Number.isFinite(total) || total <= 0 || Number.isNaN(start) || Number.isNaN(spanStart)) return undefined;
  const startOffsetMs = spanStart - start;
  const left = Math.min(100, Math.max(0, (startOffsetMs / total) * 100));
  const durationMs = span.durationMs;
  const instant = durationMs === 0 && !span.incomplete;
  const openEnded = span.incomplete;
  const width = openEnded
    ? 100 - left
    : instant
      ? 0
      : Math.max(0.5, Math.min(100 - left, ((durationMs ?? 0) / total) * 100));
  const spanEnd = observedEnd(span);
  const parentEnd = parent ? observedEnd(parent) : undefined;
  return {
    left,
    width,
    startOffsetMs,
    durationMs,
    instant,
    openEnded,
    endsAfterParent: spanEnd !== undefined && parentEnd !== undefined && spanEnd > parentEnd,
  };
}

export function formatAttribute(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}
