import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { observationEventSchema, type ObservationEvent } from "./schema.js";

export const TRACE_CAPS = { maxEventsPerRun: 1000, maxEventBytes: 32 * 1024, maxRunBytes: 10 * 1024 * 1024 } as const;

export const ALWAYS_KEEP_TYPES: ReadonlySet<string> = new Set([
  "run.completed", "run.failed", "run.cancelled", "run.timed_out",
  "agent_service.run.completed", "agent_service.run.failed",
  "runtime.codex.completed", "runtime.codex.failed", "runtime.container.stopped",
  "error.recorded", "telemetry.degraded", "trace.truncated", "capability.unavailable", "limit.exceeded",
]);

export interface RunIndexEntry {
  runId: string; traceId: string; agentId: string; eventCount: number;
  lastSequence: number; lastTimestamp: string; bytes: number; truncated: boolean;
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
}
