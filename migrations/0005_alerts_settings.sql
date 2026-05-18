-- 0005_alerts_settings.sql
-- Adds: alert_rules, alert_events, user_settings.
-- Also widens the sources.type constraint to include docker/laravel/mysql/postgresql/syslog.

-- ── Widen sources type check ────────────────────────────────────────────────
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_type_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_type_check
  CHECK (type IN ('pm2','nginx','apache','journald','file','http',
                  'docker','laravel','mysql','postgresql','syslog'));

-- ── user_settings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL DEFAULT 90
                   CHECK (retention_days BETWEEN 1 AND 3650),
  timezone       TEXT    NOT NULL DEFAULT 'UTC',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── alert_rules ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description      TEXT NOT NULL DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT true,

  -- 'keyword' | 'threshold' | 'error_rate'
  condition_type   TEXT NOT NULL
                     CHECK (condition_type IN ('keyword','threshold','error_rate')),
  -- keyword:    { "keyword": "OOM", "severities": ["ERROR","FATAL"] }
  -- threshold:  { "count": 10, "window_sec": 300, "severities": ["ERROR"] }
  -- error_rate: { "rate": 0.1, "window_sec": 300 }
  condition        JSONB NOT NULL,

  -- Scope — at least one of project_id or source_ids must be non-null.
  project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
  source_ids       UUID[] NOT NULL DEFAULT '{}',

  -- Notification
  -- 'webhook' | 'slack' | 'email'
  notif_type       TEXT NOT NULL
                     CHECK (notif_type IN ('webhook','slack','email')),
  -- webhook: { "url": "https://..." }
  -- slack:   { "webhook_url": "https://hooks.slack.com/..." }
  -- email:   { "to": "ops@example.com" }
  notif_config     JSONB NOT NULL DEFAULT '{}'::jsonb,

  cooldown_sec     INTEGER NOT NULL DEFAULT 300 CHECK (cooldown_sec >= 60),
  last_fired_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_owner_idx   ON alert_rules(owner_id);
CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx ON alert_rules(enabled) WHERE enabled;

-- ── alert_events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Snapshot of what triggered: { "count": 12, "sample": [...] }
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  notified      BOOLEAN NOT NULL DEFAULT false,
  notif_error   TEXT
);
CREATE INDEX IF NOT EXISTS alert_events_rule_idx ON alert_events(rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_fired_idx ON alert_events(fired_at DESC);
