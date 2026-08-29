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

/** Applies apps/server/sql/*.sql in name order; every file is idempotent, so this runs on each boot.
 * Boot-time DDL, not a store query: 003 can rebuild large indexes on the first boot after an upgrade
 * (#216), so this uses a dedicated connection WITHOUT the pool's 30 s query/statement caps — those
 * exist for the emitter path (invariant 4), and applied here they would cancel a long rebuild and
 * turn every restart into the same doomed attempt. */
export async function migrate(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // No statement cap (a legacy 003 rebuild may legitimately run long), but a lock cap: if another
    // session still holds a conflicting lock (e.g. a rolling restart whose old pool lingers), boot
    // must fail fast with a real error instead of hanging silently on the lock queue.
    await client.query("SET lock_timeout = '10s'");
    for (const file of (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      await client.query(await readFile(new URL(file, SQL_DIR), "utf8"));
    }
  } finally {
    await client.end();
  }
}
