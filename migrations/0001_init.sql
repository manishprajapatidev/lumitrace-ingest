-- 0001_init.sql — base schema for lumitrace ingestion (plain Postgres / Neon).
-- Timescale-specific features (hypertable, compression, retention, continuous
-- aggregates) are intentionally omitted. Add them in a follow-up migration if
-- you later move to a TimescaleDB-enabled cluster.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ----- users / auth (minimal — wire to your auth provider as needed) ---------
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----- projects --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  environment  TEXT NOT NULL CHECK (environment IN ('production','staging','dev')),
  color        TEXT NOT NULL DEFAULT '#6366f1',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);

-- ----- sources ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('pm2','nginx','apache','journald','file','http')),
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_hash     TEXT NOT NULL UNIQUE,
  token_preview  TEXT NOT NULL,
  last_event_at  TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'awaiting'
                   CHECK (status IN ('awaiting','live','stale','error')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_project_idx ON sources(project_id);
CREATE INDEX IF NOT EXISTS sources_token_hash_idx ON sources(token_hash);

-- ----- logs hypertable -------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs (
  ts           TIMESTAMPTZ NOT NULL,
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  source_id    UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  severity     TEXT NOT NULL CHECK (severity IN ('FATAL','ERROR','WARN','INFO','DEBUG','TRACE')),
  message      TEXT NOT NULL,
  status_code  INTEGER,
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw          TEXT,
  PRIMARY KEY (source_id, ts, id)
);

CREATE INDEX IF NOT EXISTS logs_source_ts_idx     ON logs (source_id, ts DESC);
CREATE INDEX IF NOT EXISTS logs_attributes_gin    ON logs USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS logs_message_trgm_idx  ON logs USING GIN (message gin_trgm_ops);

-- ----- ingest rejections (small audit table) ---------------------------------
CREATE TABLE IF NOT EXISTS ingest_rejections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID REFERENCES sources(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT NOT NULL,
  sample      TEXT
);
CREATE INDEX IF NOT EXISTS ingest_rejections_source_idx ON ingest_rejections(source_id, ts DESC);
