-- #216: databases created before 001/002 carried COLLATE "C" sort their ordered text columns with the
-- database's locale collation, which on glibc images is not byte order — so the "byte for byte" contract
-- with the NDJSON/JSON backends silently didn't hold there. Fix existing tables in place.
-- Runs on every boot like every file here, so the ALTERs (which rewrite the table and its indexes) are
-- guarded to fire only while a column still has the wrong collation: after the first boot this is a
-- catalog lookup and a no-op, keeping the "idempotent DDL on every boot" contract of 001.
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'runs_summary' AND column_name IN ('run_id', 'started_at', 'updated_at')
        OR table_name = 'observation_events' AND column_name IN ('event_id', 'run_id', 'timestamp'))
      AND table_schema = current_schema()
      AND collation_name IS DISTINCT FROM 'C'
    -- Deterministic ALTER (lock) order: two concurrent migrators (server boot + backfill script) must
    -- take the ACCESS EXCLUSIVE locks in the same sequence or they can deadlock.
    ORDER BY table_name, column_name
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE text COLLATE "C"', col.table_name, col.column_name);
  END LOOP;
END $$;
