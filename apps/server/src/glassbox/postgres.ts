// Shared PostgreSQL plumbing for the opt-in GLASSBOX_STORE=postgres backends (#191, #175). Each store owns
// its pool (the app is single-process; a handful of small pools beats a shared-lifecycle dependency), but the
// migration runner is one implementation so every store boots the same schema regardless of open order.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const SQL_DIR = new URL("../../sql/", import.meta.url);

export function createPool(connectionString: string): pg.Pool {
  // query_timeout + statement_timeout: telemetry must never block the server — a hung-but-connected
  // database has to surface as an error (the emitter's telemetry.degraded path), not back up the
  // emitter's promise chain forever. Store queries are single-row lookups; 30 s is already pathological.
  return new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 30_000, statement_timeout: 30_000 });
}

/** Applies apps/server/sql/*.sql in name order; every file is idempotent, so this runs on each boot. */
export async function migrate(pool: pg.Pool): Promise<void> {
  for (const file of (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, SQL_DIR), "utf8"));
  }
}
