import { SCHEMA_VERSION, type CapturePolicy, type Category, type ObservationEvent, type TraceStatus } from "./schema.js";
import { TERMINAL_EVENT_STATUS as TERMINAL, isEvictionMarker } from "./store.js";

export interface Span {
  spanId: string; parentSpanId?: string | undefined; name: string; category: Category; status: TraceStatus;
  startedAt: string; endedAt?: string | undefined; durationMs?: number | undefined; incomplete: boolean; sequence: number;
  source: ObservationEvent["source"]; attributes: ObservationEvent["attributes"]; summary?: ObservationEvent["summary"];
  error?: ObservationEvent["error"]; events: ObservationEvent[]; children: Span[]; depth: number;
}
export interface FailureFocus {
  kind: "error" | "timeout" | "cancelled" | "denied" | "degraded"; spanId: string; eventId: string; sequence: number;
  name: string; category: Category; component: string; message?: string | undefined; path: string[]; diagnosis: string;
}
export type AuditOutcome = "allowed" | "denied" | "ok" | "error" | "timeout" | "cancelled";
export interface AuditRow {
  at: string; actor: { type: ObservationEvent["actorType"]; id: string }; action: string; resource: string;
  outcome: AuditOutcome; eventId: string; spanId: string; traceId: string; attributes: ObservationEvent["attributes"];
}
export interface TraceSummary {
  schemaVersion: typeof SCHEMA_VERSION; capturePolicy: CapturePolicy; runId: string; traceId: string; agentId: string;
  sessionId?: string | undefined; status: TraceStatus; startedAt?: string | undefined; endedAt?: string | undefined;
  workspace?: string | undefined;
  durationMs?: number | undefined; eventCount: number; spanCount: number; incompleteSpans: number; redactedEvents: number; denials: number;
  audit: { actions: number; denials: number; actors: string[] };
  /** Set when the Run was closed by AgentService.initialize() after a restart: durationMs then stops at the last event observed before the restart. */
  endedReason?: "server_restart" | undefined;
  /** Lower bound from Run start to the restart marker; unlike durationMs, this includes the unobserved gap. */
  interruptedAfterMs?: number | undefined;
  degraded: boolean; truncated: boolean;
  /** Content events were removed by retention cleanup (age/disk cap); terminal/error evidence is kept. */
  evicted: boolean;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | undefined;
  metrics: TraceMetrics;
  configHash?: string | undefined;
  /** `unknown` = no evidence either way (run cut short before the stream said anything) — never claim `unavailable` from absence. */
  capabilities: { model: Capability; tool: Capability };
  workspaceChanges?: { added: number; modified: number; removed: number; bytesDelta: number; truncated: boolean } | undefined;
  firstFailingStep?: string | undefined; failure?: FailureFocus | undefined;
}

export interface TraceMetrics {
  durationMs?: number | undefined;
  terminalStatus: TraceStatus;
  toolCalls: number;
  toolFailures: number;
  toolIdentities?: string[] | undefined;
  modelCalls: number;
  tokens?: { input?: number | undefined; cachedInput?: number | undefined; output?: number | undefined } | undefined;
  retries: number;
  denials: number;
}
export type Capability = "observed" | "unavailable" | "unknown";
export interface TraceView { summary: TraceSummary; spans: Span[]; events: ObservationEvent[] }

const CATEGORY_RANK: Record<Category, number> = { tool: 0, model: 1, runtime: 2, workspace: 3, sandbox: 4, policy: 5, infrastructure: 6, control: 7, experience: 8 };
// `tool` rows are the agent's own actions (actor agent/<id>, resource = program); without them the audit
// could never attribute anything to the agent (#135).
const AUDIT_CATEGORIES = new Set<Category>(["control", "policy", "sandbox", "tool"]);

function auditOutcome(event: ObservationEvent): AuditOutcome {
  if (event.type === "policy.denied") return "denied";
  if (event.status === "ok") return "ok";
  if (event.status === "error") return "error";
  if (event.status === "timeout") return "timeout";
  if (event.status === "cancelled") return "cancelled";
  return "allowed";
}

function isRuntimeTerminal(event: ObservationEvent): boolean {
  return event.category === "runtime" && event.phase === "end";
}

/** A derived, linkable audit view. It deliberately introduces no events or storage of its own. */
export function projectAudit(events: ObservationEvent[]): AuditRow[] {
  return events
    .filter((event) => AUDIT_CATEGORIES.has(event.category) || isRuntimeTerminal(event))
    .map((event) => ({
      at: event.timestamp,
      actor: { type: event.actorType, id: event.actorId },
      action: event.type,
      resource: typeof event.attributes.program === "string" && event.attributes.program.length > 0 ? event.attributes.program : event.name || event.runId,
      outcome: auditOutcome(event),
      eventId: event.eventId,
      spanId: event.spanId,
      traceId: event.traceId,
      attributes: event.attributes,
    }));
}

export function flattenSpans(spans: Span[]): Span[] {
  const out: Span[] = []; const walk = (s: Span) => { out.push(s); s.children.forEach(walk); }; spans.forEach(walk); return out;
}

function reconstructSpans(events: ObservationEvent[]): Map<string, Span> {
  const spans = new Map<string, Span>();
  for (const e of events) {
    const existing = spans.get(e.spanId);
    if (e.phase === "start") {
      if (!existing) {
        spans.set(e.spanId, { spanId: e.spanId, parentSpanId: e.parentSpanId, name: e.name, category: e.category, status: "running",
          startedAt: e.timestamp, incomplete: true, sequence: e.sequence, source: e.source, attributes: { ...e.attributes },
          summary: e.summary, error: e.error, events: [], children: [], depth: 0 });
        continue;
      }
      // A `start` event is authoritative for timing even when it arrives after the matching `end` (out-of-order
      // delivery): always (re)establish startedAt/sequence from it, and once both phases have been observed,
      // close the span for real (recompute durationMs, clear incomplete).
      existing.startedAt = e.timestamp;
      existing.sequence = e.sequence;
      if (existing.endedAt !== undefined) {
        existing.durationMs = Math.max(0, Date.parse(existing.endedAt) - Date.parse(e.timestamp));
        existing.incomplete = false;
      } else {
        existing.events.push(e);
      }
      continue;
    }
    if (!existing) {
      const span: Span = { spanId: e.spanId, parentSpanId: e.parentSpanId, name: e.name, category: e.category, status: e.status,
        startedAt: e.timestamp, incomplete: e.phase === "end", sequence: e.sequence, source: e.source, attributes: { ...e.attributes },
        summary: e.summary, error: e.error, events: [], children: [], depth: 0 };
      if (e.phase === "instant") {
        span.endedAt = e.timestamp; span.durationMs = e.durationMs ?? 0;
      } else {
        // `end` arrived with no `start` yet seen: derive a provisional startedAt from durationMs (else fall back
        // to the end timestamp) but stay `incomplete: true` — honest per invariant #7 — until a real `start`
        // event corrects it above. Never guess a span closed.
        span.endedAt = e.timestamp;
        span.durationMs = e.durationMs;
        span.startedAt = e.durationMs !== undefined ? new Date(Date.parse(e.timestamp) - e.durationMs).toISOString() : e.timestamp;
      }
      spans.set(e.spanId, span);
    } else if (e.phase === "end") {
      existing.endedAt = e.timestamp; existing.status = e.status; existing.incomplete = false;
      existing.name = existing.name === existing.spanId ? e.name : existing.name;
      existing.durationMs = e.durationMs ?? Math.max(0, Date.parse(e.timestamp) - Date.parse(existing.startedAt));
      Object.assign(existing.attributes, e.attributes); if (e.error) existing.error = e.error; if (e.summary) existing.summary = e.summary;
    } else {
      existing.events.push(e);
    }
  }
  return spans;
}

function buildTree(spans: Map<string, Span>): Span[] {
  const roots: Span[] = [];
  for (const s of spans.values()) { const p = s.parentSpanId ? spans.get(s.parentSpanId) : undefined; if (p) p.children.push(s); else roots.push(s); }
  const sortRec = (list: Span[], depth: number) => { list.sort((a, b) => a.sequence - b.sequence); for (const s of list) { s.depth = depth; sortRec(s.children, depth + 1); } };
  sortRec(roots, 0);
  return roots;
}

function pathTo(spans: Map<string, Span>, spanId: string): string[] {
  const path: string[] = []; const visited = new Set<string>(); let cur = spans.get(spanId);
  // Guard against a parentSpanId cycle (two spans referencing each other): stop the first time a spanId repeats
  // instead of walking forever.
  while (cur && !visited.has(cur.spanId)) {
    visited.add(cur.spanId); path.unshift(cur.spanId);
    cur = cur.parentSpanId ? spans.get(cur.parentSpanId) : undefined;
  }
  return path;
}

const DEGRADED_FOCUS: FailureFocus = { kind: "degraded", spanId: "", eventId: "", sequence: -1, name: "telemetry.degraded", category: "control", component: "GlassBox", path: [], diagnosis: "Trace evidence is incomplete: the trace store was unavailable during this Run. The Run's real result is unaffected; some spans may be missing." };

const EXIT_HINTS: Record<number, string> = {
  2: "usage error, or the interpreter could not find the file",
  124: "timed out — killed by the timeout wrapper",
  126: "found but not executable — permissions or wrong interpreter",
  127: "command not found — the program is missing from the runtime image",
  130: "interrupted — SIGINT",
  137: "SIGKILL (timeout, cancellation, or out-of-memory termination)",
  3221225794: "process failed to initialise — the runtime CLI could not start; restart the server",
};

export function formatExitCode(code: number): string {
  const decimal = String(code);
  const hex = Number.isInteger(code) && code >= 0x80000000 && code <= 0xffffffff
    ? ` (0x${code.toString(16).toUpperCase().padStart(8, "0")})`
    : "";
  const hint = EXIT_HINTS[code];
  return decimal + hex + (hint ? ` — ${hint}` : "");
}

const formatFailureMessage = (message: string | undefined): string | undefined => {
  // Matches the observer's bare "exit code N" and the runners' "Codex exited with code N: detail".
  return message?.replace(/\b((?:exited with|exit) code )(\d+)/i, (_, prefix: string, code: string) => prefix + formatExitCode(Number(code)));
};

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return "an unknown duration";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

function focusFailure(events: ObservationEvent[], spans: Map<string, Span>, status: TraceStatus, degraded: boolean, durationMs: number | undefined, interruptedAfterMs?: number): FailureFocus | undefined {
  const denial = events.find((e) => e.type === "policy.denied");
  // A handled ordinary tool error is not actionable after an ok terminal, but a policy decision is:
  // the Run may recover while operators still need to know what the sandbox declined.
  if (status === "ok" && !denial) return degraded ? DEGRADED_FOCUS : undefined;
  const candidates = events.filter((e) => e.status === "error" || e.status === "timeout" || e.status === "cancelled" || e.type === "error.recorded");
  if (candidates.length === 0) return degraded ? DEGRADED_FOCUS : undefined;
  // The Run's terminal status names the failure kind; rank events that match it first so a handled
  // tool.call.failed earlier in the stream can't outrank the timeout/cancel that actually ended the Run.
  const matches = (e: ObservationEvent) => e.status === status || (status === "error" && e.type === "error.recorded");
  const denialRank = (e: ObservationEvent) => Number(e.type === "policy.denied" && (status === "ok" || status === "error"));
  candidates.sort((a, b) => Number(matches(b)) - Number(matches(a)) || denialRank(b) - denialRank(a) || a.sequence - b.sequence || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  const first = candidates[0]!;
  const kind: FailureFocus["kind"] = first.type === "policy.denied" ? "denied" : first.status === "timeout" ? "timeout" : first.status === "cancelled" ? "cancelled" : "error";
  // A restart-cancel is a synthetic control event with no evidence of its own: point at the span the restart cut
  // off instead — deepest incomplete runtime span, else deepest incomplete span of any category, else the cancel.
  const open = isRestartCancel(first)
    ? [...spans.values()].filter((s) => s.incomplete).sort((a, b) => Number(b.category === "runtime") - Number(a.category === "runtime") || b.depth - a.depth || b.sequence - a.sequence)[0]
    : undefined;
  const target = open
    ? { spanId: open.spanId, eventId: events.find((e) => e.spanId === open.spanId)?.eventId ?? first.eventId, sequence: open.sequence, name: open.name, category: open.category, component: open.source.component, message: undefined }
    : { spanId: first.spanId, eventId: first.eventId, sequence: first.sequence, name: first.name, category: first.category, component: first.source.component, message: formatFailureMessage(first.error?.message) };
  const path = pathTo(spans, target.spanId);
  const elapsed = formatElapsed(durationMs);
  const secs = durationMs === undefined ? "an unknown duration" : (durationMs / 1000).toFixed(1) + " s";
  const cleanup = events.find((e) => e.type === "runtime.container.stopped" || (e.type === "runtime.codex.failed" && e.attributes.terminationSignal));
  const capability = events.find((e) => e.type === "capability.unavailable");
  const diagnosis = [
    kind === "denied"
      ? `sandbox declined \`${String(first.attributes.program || first.name)}\``
      : isRestartCancel(first)
      ? `Run interrupted by a server restart after ${formatElapsed(interruptedAfterMs)}; last trace evidence was ${elapsed} after the Run started; ${open ? `the ${open.category} span ${open.name} never closed` : "no open span was recorded"}.`
      : `Run ${status} in ${first.source.component} after ${secs}. First actionable ${kind}: ${first.name}${target.message ? " — " + target.message : ""}.`,
    cleanup ? `Cleanup evidence: ${cleanup.name}${typeof cleanup.attributes.exitCode === "number" ? " (exit " + formatExitCode(cleanup.attributes.exitCode) + ")" : ""}${cleanup.attributes.terminationSignal ? " via " + String(cleanup.attributes.terminationSignal) : ""}.` : "",
    capability ? "No model/tool-level details were available from the runtime." : "",
    degraded ? "Trace store was degraded during this Run; evidence may be incomplete." : "",
  ].filter(Boolean).join(" ");
  return { kind, ...target, path, diagnosis };
}

const isRestartCancel = (e: ObservationEvent): boolean => e.type === "run.cancelled" && e.attributes.reason === "server_restart";

export function buildTrace(input: ObservationEvent[], opts: { capturePolicy: CapturePolicy; degraded?: boolean | undefined; truncated?: boolean | undefined }): TraceView {
  const events = [...input].sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp));
  const spans = reconstructSpans(events);
  const tree = buildTree(spans);
  const flat = flattenSpans(tree);
  const first = events[0];
  const terminal = [...events].reverse().find((e) => TERMINAL[e.type] !== undefined);
  const status: TraceStatus = terminal ? TERMINAL[terminal.type]! : events.length > 0 ? "running" : "unset";
  const startedAt = first?.timestamp;
  const endedAt = terminal?.timestamp ?? (status === "running" ? undefined : events.at(-1)?.timestamp);
  // Interrupted by a restart: endedAt keeps the restart-cancel timestamp (that IS when the Run was closed), but the
  // clock stops at the last event observed before it — nothing was seen in the gap, so counting it would be fabricated.
  const restart = terminal !== undefined && isRestartCancel(terminal);
  const clockEnd = restart ? events[events.indexOf(terminal) - 1]?.timestamp : endedAt;
  const durationMs = startedAt && clockEnd ? Math.max(0, Date.parse(clockEnd) - Date.parse(startedAt)) : undefined;
  // The restart-cancel is stamped at the NEXT boot, which may be hours after the process died: the honest lower bound on
  // how long the Run lived is the previous process's last heartbeat (run.cancelled.attributes.lastSeenAt), else the last evidence.
  const lastSeenAt = restart && typeof terminal.attributes.lastSeenAt === "string" ? Date.parse(terminal.attributes.lastSeenAt) : NaN;
  const interruptedAfterMs = restart && startedAt ? Math.max(durationMs ?? 0, Number.isNaN(lastSeenAt) ? 0 : lastSeenAt - Date.parse(startedAt)) : undefined;
  const usageEvents = events.filter((e) => e.type === "model.completed");
  const sum = (k: string) => usageEvents.reduce((n, e) => n + (typeof e.attributes[k] === "number" ? (e.attributes[k] as number) : 0), 0);
  // Presence-based, not truthiness-based: include a usage field whenever ANY model.completed event carries it
  // numerically, even if the total happens to sum to 0.
  const hasNumeric = (k: string) => usageEvents.some((e) => typeof e.attributes[k] === "number");
  const usage = usageEvents.length
    ? { ...(hasNumeric("inputTokens") ? { inputTokens: sum("inputTokens") } : {}),
        ...(hasNumeric("cachedInputTokens") ? { cachedInputTokens: sum("cachedInputTokens") } : {}),
        ...(hasNumeric("outputTokens") ? { outputTokens: sum("outputTokens") } : {}) }
    : undefined;
  const toolSpans = flat.filter((span) =>
    span.category === "tool" && events.some((event) => event.spanId === span.spanId && event.type.startsWith("tool.call.")),
  );
  const modelSpans = flat.filter((span) =>
    span.category === "model" && events.some((event) => event.spanId === span.spanId && event.type.startsWith("model.")),
  );
  const retrySpans = new Set(events.filter((event) => event.attempt > 1).map((event) => event.spanId));
  const toolIdentities = [...new Set(toolSpans.map((span) => {
    const program = typeof span.attributes.program === "string" ? span.attributes.program : "";
    const argument0 = typeof span.attributes.argument0 === "string" ? span.attributes.argument0 : "";
    return [program, argument0].filter(Boolean).join(" ");
  }).filter(Boolean))].slice(0, 3);
  const metrics: TraceMetrics = {
    ...(durationMs !== undefined ? { durationMs } : {}),
    terminalStatus: status,
    toolCalls: toolSpans.length,
    toolFailures: toolSpans.filter((span) =>
      span.status === "error" || span.status === "timeout" || span.status === "cancelled" ||
      events.some((event) => event.spanId === span.spanId && event.type === "tool.call.failed"),
    ).length,
    ...(toolIdentities.length > 0 ? { toolIdentities } : {}),
    modelCalls: modelSpans.length,
    ...(usage && (usage.inputTokens !== undefined || usage.cachedInputTokens !== undefined || usage.outputTokens !== undefined)
      ? { tokens: {
          ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
          ...(usage.cachedInputTokens !== undefined ? { cachedInput: usage.cachedInputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}),
        } }
      : {}),
    retries: retrySpans.size,
    denials: events.filter((event) => event.type === "policy.denied").length,
  };
  const createdConfigHash = events.find((event) => event.type === "run.created")?.attributes.configHash;
  const configHash = typeof createdConfigHash === "string" ? createdConfigHash : undefined;
  const degraded = opts.degraded === true || events.some((e) => e.type === "telemetry.degraded");
  const truncated = opts.truncated === true || events.some((e) => e.type === "trace.truncated");
  const evicted = events.some(isEvictionMarker);
  const failure = focusFailure(events, spans, status, degraded, durationMs, interruptedAfterMs);
  const auditRows = projectAudit(events);
  const declaredUnavailable = events.some((e) => e.type === "capability.unavailable");
  const workspace = events.find((event) => event.type === "run.created" && typeof event.attributes.workspace === "string")?.attributes.workspace;
  // Two emitters share this type: the runtime stream's file_change report ({ fileCount, added, updated, deleted })
  // and the platform's before/after disk snapshot ({ added, modified, removed, bytesDelta, paths }). The snapshot
  // is the honest source (it saw the disk); the stream report is only a fallback, with its vocabulary normalised.
  const workspaceEvents = events.filter((event) => event.type === "workspace.changed");
  const workspaceEvent = workspaceEvents.find((event) => event.source.adapter === "WorkspaceSnapshot") ?? workspaceEvents.at(-1);
  const workspaceChanges = workspaceEvent ? {
    added: Number(workspaceEvent.attributes.added ?? 0),
    modified: Number(workspaceEvent.attributes.modified ?? workspaceEvent.attributes.updated ?? 0),
    removed: Number(workspaceEvent.attributes.removed ?? workspaceEvent.attributes.deleted ?? 0),
    bytesDelta: Number(workspaceEvent.attributes.bytesDelta ?? 0),
    truncated: workspaceEvent.attributes.truncated === true,
  } : undefined;
  const summary: TraceSummary = {
    schemaVersion: SCHEMA_VERSION, capturePolicy: opts.capturePolicy,
    runId: first?.runId ?? "", traceId: first?.traceId ?? "", agentId: first?.agentId ?? "",
    sessionId: events.find((e) => e.sessionId)?.sessionId,
    ...(typeof workspace === "string" ? { workspace } : {}),
    status, startedAt, endedAt, durationMs, endedReason: restart ? "server_restart" : undefined, interruptedAfterMs, eventCount: events.length, spanCount: flat.length,
    incompleteSpans: flat.filter((s) => s.incomplete).length, redactedEvents: events.filter((e) => e.privacy.redacted).length,
    denials: events.filter((e) => e.type === "policy.denied").length,
    audit: {
      actions: auditRows.length,
      denials: auditRows.filter((row) => row.outcome === "denied").length,
      actors: [...new Set(auditRows.map((row) => row.actor.type + "/" + row.actor.id))].sort(),
    },
    degraded, truncated, evicted, usage, metrics, configHash, workspaceChanges,
    capabilities: { model: events.some((e) => e.category === "model") ? "observed" : declaredUnavailable ? "unavailable" : "unknown", tool: events.some((e) => e.category === "tool") ? "observed" : declaredUnavailable ? "unavailable" : "unknown" },
    firstFailingStep: failure && failure.kind !== "degraded" ? failure.name : undefined, failure,
  };
  return { summary, spans: tree, events };
}
