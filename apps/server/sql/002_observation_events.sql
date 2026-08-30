-- ObservationEvents on PostgreSQL (#175 phase B). `doc` is the full redacted event (redaction happens before
-- append, so nothing raw ever reaches this table); the scalar columns exist only for the three query patterns
-- the store actually has. Timestamps are ISO-8601 text so ordering matches the NDJSON backend byte for byte —
-- COLLATE "C" on the ordered columns (event_id tiebreak, run_id, timestamp) makes that true on glibc images
-- too, where the locale default is not byte order (#216).
-- The PK doubles as the duplicate-suppression guard: append inserts with ON CONFLICT (event_id) DO NOTHING.
CREATE TABLE IF NOT EXISTS observation_events (
  event_id   text COLLATE "C" PRIMARY KEY,
  run_id     text COLLATE "C" NOT NULL,
  trace_id   text NOT NULL,
  agent_id   text NOT NULL,
  sequence   bigint NOT NULL,
  timestamp  text COLLATE "C" NOT NULL,
  event_type text NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_events_run_sequence ON observation_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_trace_sequence ON observation_events (trace_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_agent_timestamp ON observation_events (agent_id, timestamp);
