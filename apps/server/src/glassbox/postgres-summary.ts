// PostgreSQL backend for RunSummaryStore (#191, phase C of #175). Opt-in via GLASSBOX_STORE=postgres; the judged
// path stays on JsonStore. Same filter, ordering and 404 semantics as JsonRunSummaryStore — summary.test.ts runs
// the store cases against both backends when DATABASE_URL is set.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import { JsonRunSummaryStore, type RunSummary, type RunSummaryQuery, type RunSummaryStore, type TaskOutcome } from "./summary.js";

const SQL_DIR = new URL("../../sql/", import.meta.url);

export class PostgresRunSummaryStore implements RunSummaryStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  /** Applies apps/server/sql/*.sql in name order; every file is idempotent, so this runs on each boot. */
  async migrate(): Promise<void> {
    for (const file of (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      await this.pool.query(await readFile(new URL(file, SQL_DIR), "utf8"));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsert(s: RunSummary): Promise<void> {
    await this.pool.query(
      `INSERT INTO runs_summary (run_id, agent_id, config_hash, started_at, execution_status, task_outcome, rollup_version, updated_at, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (run_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, config_hash = EXCLUDED.config_hash, started_at = EXCLUDED.started_at,
         execution_status = EXCLUDED.execution_status, task_outcome = EXCLUDED.task_outcome, rollup_version = EXCLUDED.rollup_version,
         updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
      [s.runId, s.agentId, s.configHash ?? null, s.startedAt ?? null, s.executionStatus, s.taskOutcome, s.rollupVersion, s.updatedAt, JSON.stringify(s)],
    );
  }

  async get(runId: string): Promise<RunSummary | undefined> {
    const { rows } = await this.pool.query<{ doc: RunSummary }>("SELECT doc FROM runs_summary WHERE run_id = $1", [runId]);
    return rows[0]?.doc;
  }

  async query(q: RunSummaryQuery = {}): Promise<RunSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
    if (q.agentId) add("agent_id = ?", q.agentId);
    if (q.configHash) add("config_hash = ?", q.configHash);
    if (q.executionStatus) add("execution_status = ?", q.executionStatus);
    if (q.taskOutcome) add("task_outcome = ?", q.taskOutcome);
    // COALESCE to '' mirrors the JSON store: a summary without startedAt fails `from` and passes `to`.
    if (q.from) add("COALESCE(started_at, '') >= ?", q.from);
    if (q.to) add("COALESCE(started_at, '') <= ?", q.to);
    const limit = q.limit === undefined ? "" : ` LIMIT $${params.push(q.limit)}`;
    const { rows } = await this.pool.query<{ doc: RunSummary }>(
      `SELECT doc FROM runs_summary${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(started_at, updated_at) DESC${limit}`,
      params,
    );
    return rows.map((r) => r.doc);
  }

  async setTaskOutcome(runId: string, outcome: TaskOutcome, source: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    const { rowCount } = await this.pool.query(
      `UPDATE runs_summary SET task_outcome = $2, updated_at = $4,
         doc = doc || jsonb_build_object('taskOutcome', $2::text, 'taskOutcomeSource', $3::text, 'updatedAt', $4::text)
       WHERE run_id = $1`,
      [runId, outcome, source, updatedAt],
    );
    if (!rowCount) throw new HttpError(404, "Run summary not found");
  }
}

/** Picks the backend from config; the server and the backfill script both go through here so GLASSBOX_STORE is honoured once. */
export async function openSummaryStore(config: { glassboxStore: "json" | "postgres"; databaseUrl?: string | undefined }, json: JsonStore): Promise<RunSummaryStore> {
  if (config.glassboxStore !== "postgres") return new JsonRunSummaryStore(json);
  if (!config.databaseUrl) throw new Error("GLASSBOX_STORE=postgres requires DATABASE_URL");
  const store = new PostgresRunSummaryStore(config.databaseUrl);
  await store.migrate();
  return store;
}
