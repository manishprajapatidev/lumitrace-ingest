-- 0003_timescale.sql — Enable TimescaleDB features on the logs table.
-- Run this AFTER 0001_init.sql and 0002_auth.sql on a TimescaleDB-enabled cluster.
-- Safe to run on: Timescale Cloud, self-hosted TimescaleDB >= 2.x
-- NOT compatible with: Supabase PG17, Neon, plain Postgres.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Convert logs to a hypertable partitioned by time ─────────────────────────
-- chunk_time_interval = 1 day: each day's logs live in its own chunk.
-- This makes range queries (from/to filters) extremely fast and enables
-- per-chunk compression + per-chunk retention.
SELECT create_hypertable(
  'logs',
  'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists       => TRUE,
  migrate_data        => TRUE
);

-- ── Compression ──────────────────────────────────────────────────────────────
-- Compress chunks older than 7 days. Typical ratio: 10-20x.
-- source_id + severity as segment keys means queries filtered by source
-- decompress only relevant segments.
ALTER TABLE logs SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'source_id, severity',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy(
  'logs',
  compress_after  => INTERVAL '7 days',
  if_not_exists   => TRUE
);

-- ── Retention policy ─────────────────────────────────────────────────────────
-- Drop chunks older than 90 days automatically.
-- Adjust the interval to match your pricing tier / customer SLA.
SELECT add_retention_policy(
  'logs',
  drop_after    => INTERVAL '90 days',
  if_not_exists => TRUE
);

-- ── Continuous aggregate: per-hour log counts per source ─────────────────────
-- Used by the frontend dashboard for volume charts without scanning raw logs.
CREATE MATERIALIZED VIEW IF NOT EXISTS logs_hourly
WITH (timescaledb.continuous) AS
  SELECT
    time_bucket('1 hour', ts)  AS bucket,
    source_id,
    severity,
    COUNT(*)                   AS log_count
  FROM logs
  GROUP BY bucket, source_id, severity
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'logs_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

-- ── Indexes (TimescaleDB re-creates these per chunk automatically) ─────────────
-- The indexes from 0001_init.sql are inherited — no action needed here.
