import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { REDACTION_RULESET_VERSION, SCHEMA_VERSION, newId, observationEventSchema, type ObservationEvent, type TraceStatus } from "./schema.js";

export const TRACE_CAPS = { maxEventsPerRun: 1000, maxEventBytes: 32 * 1024, maxRunBytes: 10 * 1024 * 1024 } as const;

export const ALWAYS_KEEP_TYPES: ReadonlySet<string> = new Set([
  "run.completed", "run.failed", "run.cancelled", "run.timed_out",
  "agent_service.run.completed", "agent_service.run.failed",
  "runtime.codex.completed", "runtime.codex.failed", "runtime.container.stopped",
  "error.recorded", "telemetry.degraded", "trace.truncated", "capability.unavailable", "limit.exceeded",
]);

/** Run terminal events → trace status. Shared by the index (retention needs "is this Run finished?") and the query rollup. */
export const TERMINAL_EVENT_STATUS: Record<string, TraceStatus> = { "run.completed": "ok", "run.failed": "error", "run.cancelled": "cancelled", "run.timed_out": "timeout" };
export type EvictionReason = "retention_age" | "retention_disk";
/** A `trace.truncated` written by retention cleanup (vs. one written by the emitter on a per-run cap). */
export const isEvictionMarker = (e: ObservationEvent): boolean =>
  e.type === "trace.truncated" && typeof e.attributes.reason === "string" && e.attributes.reason.startsWith("retention_");

export interface RunIndexEntry {
  runId: string; traceId: string; agentId: string; eventCount: number;
  lastSequence: number; lastTimestamp: string; bytes: number; truncated: boolean;
  /** `running` until a run.* terminal event is stored; retention never touches `running` Runs. */
  status: TraceStatus;
  /** Content events were removed by retention cleanup; only terminal/error metadata + the tombstone remain. */
  evicted: boolean;
}
export interface CleanupOptions { retentionDays: number; maxDiskMb: number; now?: Date | undefined }
export interface CleanupReport {
  runs: number; bytesBefore: number; bytesAfter: number;
  /** Disk cap enabled but not reachable: every finished Run is already a skeleton (or running Runs hold the bytes). */
  overCap: boolean;
  evicted: { runId: string; traceId: string; status: TraceStatus; reason: EvictionReason; bytesFreed: number }[];
}
export type AppendResult = { stored: true } | { stored: false; reason: "duplicate" | "cap_events" | "cap_bytes" };

export interface TraceStore {
  initialize(): Promise<void>;
  append(event: ObservationEvent): Promise<AppendResult>;
  readRun(runId: string): Promise<ObservationEvent[]>;
  runIdForTrace(traceId: string): string | undefined;
  listRuns(): RunIndexEntry[];
  markTruncated(runId: string): void;
}

export function shrinkToCap(event: ObservationEvent): ObservationEvent {
  if (Buffer.byteLength(JSON.stringify(event), "utf8") <= TRACE_CAPS.maxEventBytes) return event;
  const out: ObservationEvent = { ...event, attributes: {}, privacy: { ...event.privacy, redacted: true, reason: "event_truncated" } };
  delete out.summary;
  return out;
}

const keepAlways = (e: ObservationEvent) => ALWAYS_KEEP_TYPES.has(e.type) || e.status === "error" || e.status === "timeout" || e.status === "cancelled";

/** Shared index/cap logic; subclasses only implement raw persistence. */
abstract class BaseTraceStore implements TraceStore {
  protected readonly index = new Map<string, RunIndexEntry>();
  protected readonly seen = new Map<string, Set<string>>();
  protected readonly traceToRun = new Map<string, string>();
  // ponytail: per-runId promise queue, same pattern as JsonStore.mutate (../store.ts) —
  // serialises admit->persist->track so concurrent appends to one run can't both pass the cap check.
  private readonly queues = new Map<string, Promise<void>>();

  abstract initialize(): Promise<void>;
  protected abstract persist(event: ObservationEvent, line: string): Promise<void>;
  abstract readRun(runId: string): Promise<ObservationEvent[]>;

  protected admit(event: ObservationEvent): AppendResult | ObservationEvent {
    const ids = this.seen.get(event.runId) ?? new Set<string>();
    if (ids.has(event.eventId)) return { stored: false, reason: "duplicate" };
    const entry = this.index.get(event.runId);
    if (entry && !keepAlways(event)) {
      if (entry.eventCount >= TRACE_CAPS.maxEventsPerRun) return { stored: false, reason: "cap_events" };
      if (entry.bytes >= TRACE_CAPS.maxRunBytes) return { stored: false, reason: "cap_bytes" };
    }
    return shrinkToCap(event);
  }

  protected track(event: ObservationEvent, bytes: number): void {
    const ids = this.seen.get(event.runId) ?? new Set<string>(); ids.add(event.eventId); this.seen.set(event.runId, ids);
    const prev = this.index.get(event.runId);
    this.index.set(event.runId, {
      runId: event.runId, traceId: event.traceId, agentId: event.agentId,
      eventCount: (prev?.eventCount ?? 0) + 1,
      lastSequence: Math.max(prev?.lastSequence ?? -1, event.sequence),
      lastTimestamp: prev && prev.lastTimestamp > event.timestamp ? prev.lastTimestamp : event.timestamp,
      bytes: (prev?.bytes ?? 0) + bytes,
      truncated: (prev?.truncated ?? false) || event.type === "trace.truncated",
      status: TERMINAL_EVENT_STATUS[event.type] ?? prev?.status ?? "running",
      evicted: (prev?.evicted ?? false) || isEvictionMarker(event),
    });
    this.traceToRun.set(event.traceId, event.runId);
  }

  async append(event: ObservationEvent): Promise<AppendResult> {
    let result!: AppendResult;
    const prior = this.queues.get(event.runId) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const admitted = this.admit(event);
      if ("stored" in admitted) {
        // A dropped event is a truncation the moment it happens, not only once the emitter lands trace.truncated.
        if (!admitted.stored && admitted.reason !== "duplicate") this.markTruncated(event.runId);
        result = admitted; return;
      }
      const line = JSON.stringify(admitted) + "\n";
      await this.persist(admitted, line);
      this.track(admitted, Buffer.byteLength(line, "utf8"));
      result = { stored: true };
    });
    this.queues.set(event.runId, operation.catch(() => undefined));
    await operation;
    return result;
  }
  runIdForTrace(traceId: string): string | undefined { return this.traceToRun.get(traceId); }
  listRuns(): RunIndexEntry[] { return [...this.index.values()].sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp)); }
  markTruncated(runId: string): void { const e = this.index.get(runId); if (e) e.truncated = true; }
}

export class MemoryTraceStore extends BaseTraceStore {
  private readonly events = new Map<string, ObservationEvent[]>();
  async initialize(): Promise<void> {}
  protected async persist(event: ObservationEvent): Promise<void> {
    const list = this.events.get(event.runId) ?? []; list.push(event); this.events.set(event.runId, list);
  }
  async readRun(runId: string): Promise<ObservationEvent[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }
}

export class NdjsonTraceStore extends BaseTraceStore {
  /** `log` surfaces silently dropped lines: without it a schemaVersion bump would empty every trace
   * and read as an empty history rather than as a migration the operator still has to do. */
  constructor(
    private readonly directory: string,
    private readonly log?: ((message: string, meta: Record<string, unknown>) => void) | undefined,
  ) { super(); }
  /** Files whose skipped lines were already reported: readRun re-parses on every poll, so report once per file per process. */
  private readonly reported = new Set<string>();
  private file(runId: string): string { return path.join(this.directory, runId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".ndjson"); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.index.clear(); this.seen.clear(); this.traceToRun.clear();
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".ndjson")) continue;
      const file = path.join(this.directory, name);
      let raw = "";
      try { raw = await readFile(file, "utf8"); } catch { continue; }
      // A crash mid-write leaves a partial last line with no "\n"; the next append would glue onto it and
      // corrupt both records. Close the line now so every later append starts fresh.
      if (raw.length > 0 && !raw.endsWith("\n")) await appendFile(file, "\n", { encoding: "utf8", mode: 0o600 });
      for (const event of this.parseLines(raw, file)) {
        const ids = this.seen.get(event.runId);
        if (ids?.has(event.eventId)) continue;
        this.track(event, Buffer.byteLength(JSON.stringify(event) + "\n", "utf8"));
      }
    }
  }
  /** Unparseable lines and lines that fail the schema are skipped, but never silently: the count is
   * reported through `log` so a bad write or a schema migration is visible instead of looking empty. */
  private async parseFile(file: string): Promise<ObservationEvent[]> {
    let raw = "";
    try { raw = await readFile(file, "utf8"); } catch { return []; }
    return this.parseLines(raw, file);
  }
  private parseLines(raw: string, file: string): ObservationEvent[] {
    const out: ObservationEvent[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = observationEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data); else skipped++;
      } catch { skipped++; }
    }
    if (skipped > 0 && !this.reported.has(file)) { this.reported.add(file); this.log?.("trace.lines_skipped", { file, skipped }); }
    return out;
  }
  protected async persist(event: ObservationEvent, line: string): Promise<void> {
    await appendFile(this.file(event.runId), line, { encoding: "utf8", mode: 0o600 });
  }
  async readRun(runId: string): Promise<ObservationEvent[]> {
    const seen = new Set<string>();
    return (await this.parseFile(this.file(runId)))
      .filter((e) => e.runId === runId) // sanitized filenames can collide across distinct runIds
      .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Retention (FR-14), startup-only. Age: Runs whose LAST event is older than `retentionDays`. Disk: while total
   * indexed bytes exceed `maxDiskMb`, evict the oldest finished Run. `0` disables a knob. Eviction never deletes a
   * file: it compacts the Run to a metadata skeleton — always-kept terminal/error events, the root run.* events, the
   * `start` half of every kept span and both halves of `model.turn` (`model.completed` usage, #129) — plus one `trace.truncated` (`reason: retention_*`)
   * tombstone, so status/startedAt/durationMs/incomplete/usage roll up identically and the Run survives a rebuild.
   * A Run whose file fails to compact is logged (`retention.evict_failed`) and skipped; the pass continues.
   */
  async cleanup(opts: CleanupOptions): Promise<CleanupReport> {
    const now = opts.now ?? new Date();
    const total = () => [...this.index.values()].reduce((n, e) => n + e.bytes, 0);
    const report: CleanupReport = { runs: this.index.size, bytesBefore: total(), bytesAfter: 0, overCap: false, evicted: [] };
    // ponytail: a Run with no terminal event stays forever ("running" = never evict); AgentService.initialize()
    // writes run.cancelled for interrupted Runs on the next boot, so this only leaks if telemetry was degraded.
    const finished = () => [...this.index.values()].filter((e) => e.status !== "running" && !e.evicted).sort((a, b) => a.lastTimestamp.localeCompare(b.lastTimestamp));
    const tryEvict = async (e: RunIndexEntry, reason: EvictionReason) => {
      try { const r = await this.evict(e, reason, now); if (r) report.evicted.push(r); }
      catch (error) { this.log?.("retention.evict_failed", { runId: e.runId, reason, error: String(error).slice(0, 200) }); }
    };
    if (opts.retentionDays > 0) {
      const cutoff = new Date(now.getTime() - opts.retentionDays * 86_400_000).toISOString();
      for (const e of finished()) if (e.lastTimestamp < cutoff) await tryEvict(e, "retention_age");
    }
    if (opts.maxDiskMb > 0) {
      const cap = opts.maxDiskMb * 1024 * 1024;
      for (const e of finished()) { if (total() <= cap) break; await tryEvict(e, "retention_disk"); }
      report.overCap = total() > cap;
    }
    report.bytesAfter = total();
    return report;
  }

  /** Returns undefined (and touches nothing) when the Run is already a skeleton — an eviction that drops nothing is not one. */
  private async evict(entry: RunIndexEntry, reason: EvictionReason, now: Date): Promise<CleanupReport["evicted"][number] | undefined> {
    const file = this.file(entry.runId);
    const all = await this.parseFile(file);
    const mine = all.filter((e) => e.runId === entry.runId);
    const keptSpans = new Set(mine.filter((e) => keepAlways(e) || e.type === "model.completed").map((e) => e.spanId)); // model.completed is the end half of a model.turn span (#129): keep its start so durationMs/incomplete survive
    const kept = mine.filter((e) => keepAlways(e) || e.type === "run.created" || e.type === "run.started" || e.type === "model.completed" || (e.phase === "start" && keptSpans.has(e.spanId)));
    if (kept.length === mine.length) return undefined;
    const tombstone = observationEventSchema.parse({
      schemaVersion: SCHEMA_VERSION, eventId: newId("evt"), sequence: entry.lastSequence + 1, traceId: entry.traceId, spanId: newId("spn"),
      runId: entry.runId, agentId: entry.agentId, timestamp: now.toISOString(), type: "trace.truncated", category: "control",
      name: "trace.truncated", status: "unset", source: { component: "GlassBox", observed: true },
      attributes: { reason, droppedEvents: mine.length - kept.length }, privacy: { redacted: false, rulesetVersion: REDACTION_RULESET_VERSION },
    });
    const survivors = [...all.filter((e) => e.runId !== entry.runId), ...kept, tombstone]; // other runIds sharing this sanitized filename are untouched
    // tmp + rename (same as JsonStore): a crash mid-write must not lose exactly the terminal events we promised to keep.
    await writeFile(file + ".tmp", survivors.map((e) => JSON.stringify(e) + "\n").join(""), { encoding: "utf8", mode: 0o600 });
    await rename(file + ".tmp", file);
    this.index.delete(entry.runId); this.seen.delete(entry.runId);
    for (const e of [...kept, tombstone]) this.track(e, Buffer.byteLength(JSON.stringify(e) + "\n", "utf8"));
    return { runId: entry.runId, traceId: entry.traceId, status: entry.status, reason, bytesFreed: entry.bytes - this.index.get(entry.runId)!.bytes };
  }
}
