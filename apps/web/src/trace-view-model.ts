import type { Category, Span, TraceStatus, TraceView } from "./types";

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

export function isFilterActive(f: TraceFilter): boolean {
  return f.category !== "" || f.status !== "" || f.text.trim() !== "" || f.errorsOnly;
}

export function isFailed(status: TraceStatus): boolean {
  return status === "error" || status === "timeout" || status === "cancelled";
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

/** Default expansion: every root plus the API's failure path (all ancestors of the failing span). */
export function defaultExpanded(view: TraceView): Set<string> {
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

/** Bar geometry as percentages of the run's duration; undefined when the run has no usable duration. */
export function barGeometry(span: Span, view: TraceView): { left: number; width: number } | undefined {
  const total = view.summary.durationMs;
  const start = view.summary.startedAt ? Date.parse(view.summary.startedAt) : NaN;
  if (!total || Number.isNaN(start)) return undefined;
  const left = Math.min(100, Math.max(0, ((Date.parse(span.startedAt) - start) / total) * 100));
  const width = Math.max(0.5, Math.min(100 - left, ((span.durationMs ?? 0) / total) * 100));
  return { left, width };
}

export function formatAttribute(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}
