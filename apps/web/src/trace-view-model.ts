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

/** #341: header actors reuse the audit table's short form (#338) — `kind · shortId`; full `kind/id` stays in the title. */
function shortActorLabel(actor: string): string {
  const slash = actor.indexOf("/");
  return slash > 0 ? formatAuditActor({ type: actor.slice(0, slash), id: actor.slice(slash + 1) }).text : actor;
}

/** One summary-row line for `summary.audit` (#250): actors joined, capped, denial count appended. */
export function formatActors(audit: TraceView["summary"]["audit"]): { text: string; title: string } {
  const truncated = audit.actors.length > ACTOR_DISPLAY_LIMIT;
  const short = audit.actors.map(shortActorLabel);
  const shown = truncated ? short.slice(0, ACTOR_DISPLAY_LIMIT).join(" · ") + " · …" : short.join(" · ");
  const denied = audit.denials > 0 ? ` · ${audit.denials} denied` : "";
  return {
    text: (shown || "—") + denied,
    title: audit.actors.length > 0 ? `${ACTORS_TOOLTIP} All actors: ${audit.actors.join(" · ")}` : ACTORS_TOOLTIP,
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

/**
 * Restart-interrupted spans read "interrupted"; a still-open span in any other terminal trace reads
 * "never closed" (#341) — a dead Run must never wear the activity-blue RUNNING pill.
 */
export function spanStatusLabel(
  span: Pick<Span, "status" | "incomplete">,
  summary: Pick<TraceView["summary"], "status" | "endedReason">,
): string {
  if (span.incomplete && summary.endedReason === "server_restart") return "interrupted";
  if (span.status === "running" && span.incomplete && summary.status !== "running") return "never closed";
  return span.status;
}

/** #341: the discriminating first argument (e.g. the script behind 16 identical "shell:powershell.exe" rows). */
export function spanArgument(attributes: Span["attributes"]): string {
  const value = attributes.argument0;
  return typeof value === "string" ? value : "";
}

/** #341: the server diagnosis restates the banner heading's "First actionable <kind>: <name>" clause — trim it. */
export function trimDiagnosis(diagnosis: string, failure: { kind: string; name: string }): string {
  const clause = `First actionable ${failure.kind}: ${failure.name}`;
  const start = diagnosis.indexOf(clause);
  if (start === -1) return diagnosis;
  const rest = diagnosis.slice(start + clause.length);
  // Keep the error message the clause carried (" — message.") but drop a bare restatement (".").
  return (diagnosis.slice(0, start) + (rest.startsWith(" — ") ? rest.slice(3) : rest.replace(/^\.\s*/, ""))).trim();
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
 * Errors-only view (#338, #341): collapse a repeating sequence of identical leaf error rows (same name,
 * depth and error message) into its first occurrence, each kept row carrying the ×N repeat count. The
 * window is 1 or 2 rows — period 2 covers the flagship alternating tool→policy denial pairs, which a
 * consecutive-identical scan never folds. Parents are never collapsed — their children rows would be
 * orphaned in the flattened list.
 * ponytail: periods 1–2 only; extend PERIODS if a real trace ever repeats a longer window.
 */
export function coalesceErrorRows(rows: VisibleRow[]): VisibleRow[] {
  // #341 UAT: failed rows without an error payload (policy spans) are collapsible too, and rows only
  // fold when their argument0 matches — different failing commands must never share one ×N label.
  const collapsible = (row: VisibleRow) => (isFailed(row.span.status) || row.span.error !== undefined) && !row.hasChildren;
  const same = (a: VisibleRow, b: VisibleRow) =>
    a.span.name === b.span.name && a.span.depth === b.span.depth && a.span.error?.message === b.span.error?.message &&
    a.span.attributes.argument0 === b.span.attributes.argument0;
  const PERIODS = [1, 2];
  const out: VisibleRow[] = [];
  let index = 0;
  while (index < rows.length) {
    let folded = false;
    for (const period of PERIODS) {
      const window = rows.slice(index, index + period);
      if (window.length < period || !window.every(collapsible)) continue;
      let repeats = 1;
      while (window.every((w, offset) => {
        const candidate = rows[index + repeats * period + offset];
        return candidate !== undefined && collapsible(candidate) && same(w, candidate);
      })) repeats += 1;
      if (repeats > 1) {
        out.push(...window.map((w) => ({ ...w, repeat: repeats })));
        index += repeats * period;
        folded = true;
        break;
      }
    }
    if (!folded) { out.push(rows[index]!); index += 1; }
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

/** Three to six human-scale ticks (step rounding can leave three), always including the exact Run end. */
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
