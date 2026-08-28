-- RunSummary rows (#168) on PostgreSQL (#191). Indexed columns mirror RunSummaryQuery; `doc` is the full record.
-- Timestamps are ISO-8601 text so ordering and range filters match the JSON store byte for byte.
-- ponytail: idempotent DDL applied on every boot; add a schema_migrations table when the first non-idempotent change lands.
CREATE TABLE IF NOT EXISTS runs_summary (
  run_id           text PRIMARY KEY,
  agent_id         text NOT NULL,
  config_hash      text,
  started_at       text,
  execution_status text NOT NULL,
  task_outcome     text NOT NULL,
  rollup_version   integer NOT NULL,
  updated_at       text NOT NULL,
  doc              jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_summary_agent_started ON runs_summary (agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_summary_config_hash ON runs_summary (config_hash);
