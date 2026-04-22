-- 0002_auth.sql — first-party email/password auth + OTP verification.

CREATE EXTENSION IF NOT EXISTS "citext";

ALTER TABLE users
  ALTER COLUMN email TYPE CITEXT USING email::citext;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS email_otps (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash      TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_otps_expires_idx ON email_otps(expires_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_idx ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx ON refresh_tokens(user_id, expires_at)
  WHERE revoked_at IS NULL;
