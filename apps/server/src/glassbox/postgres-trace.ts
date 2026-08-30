// PostgreSQL backend for TraceStore (#175 phase B). Opt-in via GLASSBOX_STORE=postgres; the judged path stays
// on NDJSON. Redaction happens before append() exactly as with the NDJSON backend, so `doc` only ever holds
// redacted events; readRun returns the same ordered array, so buildTrace() and every query rollup are untouched.
// The index/cap/retention semantics live in BaseTraceStore — this class is only raw persistence.
import type pg from "pg";
import { observationEventSchema, type ObservationEvent } from "./schema.js";
import { createPool, migrate } from "./postgres.js";
import { BaseTraceStore, NdjsonTraceStore, type RunIndexEntry, type TraceStore, type TraceStoreLog } from "./store.js";

const INSERT = `INSERT INTO observation_events (event_id, run_id, trace_id, agent_id, sequence, timestamp, event_type, doc)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (event_id) DO NOTHING`;
// jsonb cannot store U+0000: without the replacer a NUL byte in a redacted summary/attribute (e.g. a tool
// that printed binary) would fail the insert and degrade telemetry for the whole run on this backend only.
const params = (e: ObservationEvent) => [e.eventId, e.runId, e.traceId, e.agentId, e.sequence, e.timestamp, e.type,
  JSON.stringify(e, (_key, value) => (typeof value === "string" ? value.replaceAll("\u0000", "") : value))];

export class PostgresTraceStore extends BaseTraceStore {
  private readonly pool: pg.Pool;
  /** Scopes whose skipped rows were already reported (mirrors NdjsonTraceStore.reported): once per run per process. */
  private readonly reported = new Set<string>();

  constructor(private readonly connectionString: string, log?: TraceStoreLog | undefined) {
    super(log);
    this.pool = createPool(connectionString);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async initialize(): Promise<void> {
    await migrate(this.connectionString);
    this.index.clear(); this.seen.clear(); this.traceToRun.clear();
    // Rebuild the in-memory run index the same way the NDJSON backend replays its files: one ordered scan.
    // The index stays derived state — a persisted copy could diverge from the events on a crash mid-append.
    const { rows } = await this.pool.query<{ doc: unknown }>("SELECT doc FROM observation_events ORDER BY run_id, sequence, event_id");
    for (const event of this.parseRows(rows, "initialize")) {
      this.track(event, Buffer.byteLength(JSON.stringify(event) + "\n", "utf8"));
    }
  }

  /** Rows that fail the schema are skipped, but never silently: a schemaVersion bump must read as a pending
   * migration, not as an empty history. Same contract as NdjsonTraceStore's `trace.lines_skipped`. */
  private parseRows(rows: { doc: unknown }[], scope: string): ObservationEvent[] {
    const out: ObservationEvent[] = [];
    let skipped = 0;
    for (const row of rows) {
      const parsed = observationEventSchema.safeParse(row.doc);
      if (parsed.success) out.push(parsed.data); else skipped++;
    }
    if (skipped > 0 && !this.reported.has(scope)) { this.reported.add(scope); this.log?.("trace.rows_skipped", { scope, skipped }); }
    return out;
  }

  protected async persist(event: ObservationEvent): Promise<void> {
    // The PK is the cross-restart duplicate guard; in-process duplicates never get here (admit() checks `seen`).
    // A conflicting insert must fail loudly rather than let track() count an event the table never stored:
    // unreachable from the emitter (newId("evt") is globally unique) but the index must not fabricate evidence.
    const result = await this.pool.query(INSERT, params(event));
    if (result.rowCount === 0) throw new Error(`duplicate eventId across runs: ${event.eventId}`);
  }

  async readRun(runId: string): Promise<ObservationEvent[]> {
    const { rows } = await this.pool.query<{ doc: unknown }>(
      "SELECT doc FROM observation_events WHERE run_id = $1 ORDER BY sequence, event_id", [runId],
    );
    return this.parseRows(rows, "run:" + runId); // prefixed so a runId can never collide with the "initialize" scope
  }

  protected async compact(entry: RunIndexEntry, kept: ObservationEvent[], tombstone: ObservationEvent): Promise<void> {
    // One transaction: a crash between delete and insert must not lose the tombstone we promised to keep.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM observation_events WHERE run_id = $1 AND NOT (event_id = ANY($2))", [entry.runId, kept.map((e) => e.eventId)]);
      await client.query(INSERT, params(tombstone));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Picks the trace backend from config and initializes it; index.ts and the backfill script both go through here so GLASSBOX_STORE is honoured once. */
export async function openTraceStore(
  config: { glassboxStore: "json" | "postgres"; databaseUrl?: string | undefined; traceDirectory: string },
  log?: TraceStoreLog | undefined,
): Promise<TraceStore> {
  if (config.glassboxStore !== "postgres") {
    const store = new NdjsonTraceStore(config.traceDirectory, log);
    await store.initialize();
    return store;
  }
  if (!config.databaseUrl) throw new Error("GLASSBOX_STORE=postgres requires DATABASE_URL");
  const store = new PostgresTraceStore(config.databaseUrl, log);
  try { await store.initialize(); }
  catch (error) {
    await store.close().catch(() => undefined);
    throw new Error(`Cannot reach DATABASE_URL (GLASSBOX_STORE=postgres): ${error instanceof Error ? error.message : String(error)}`);
  }
  return store;
}
