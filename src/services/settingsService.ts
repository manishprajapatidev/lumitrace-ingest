/**
 * User settings: retention policy + timezone.
 * Upserts into user_settings; on retention change attempts to apply a
 * TimescaleDB retention policy (silently skipped on plain PG installs).
 */
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { UserSettingsRow } from '../types/domain.js';

const DEFAULT_SETTINGS: Omit<UserSettingsRow, 'user_id' | 'updated_at'> = {
  retention_days: 90,
  timezone: 'UTC',
};

export const settingsService = {
  async get(userId: string): Promise<UserSettingsRow> {
    const r = await query<UserSettingsRow>(
      `SELECT * FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    if (r.rows[0]) return r.rows[0];
    // Return defaults without persisting — row is created on first PATCH.
    return {
      user_id: userId,
      ...DEFAULT_SETTINGS,
      updated_at: new Date(),
    };
  },

  async update(
    userId: string,
    patch: { retention_days?: number; timezone?: string },
  ): Promise<UserSettingsRow> {
    const r = await query<UserSettingsRow>(
      `INSERT INTO user_settings (user_id, retention_days, timezone, updated_at)
       VALUES ($1,
               COALESCE($2::int, $3::int),
               COALESCE($4::text, $5::text),
               now())
       ON CONFLICT (user_id) DO UPDATE
         SET retention_days = COALESCE($2::int, user_settings.retention_days),
             timezone        = COALESCE($4::text, user_settings.timezone),
             updated_at      = now()
       RETURNING *`,
      [
        userId,
        patch.retention_days ?? null,
        DEFAULT_SETTINGS.retention_days,
        patch.timezone ?? null,
        DEFAULT_SETTINGS.timezone,
      ],
    );
    const row = r.rows[0]!;

    // Best-effort: apply TimescaleDB retention policy when retention_days changes.
    // This is a no-op on plain PG (missing add_retention_policy function).
    if (patch.retention_days !== undefined) {
      applyRetentionPolicy(patch.retention_days).catch((err: unknown) =>
        logger.warn({ err }, 'retention policy update skipped (not TimescaleDB?)'),
      );
    }
    return row;
  },
};

async function applyRetentionPolicy(days: number): Promise<void> {
  // Remove existing policy first (ignore error if none exists).
  await query(
    `SELECT remove_retention_policy('logs', if_exists => true)`,
    [],
  ).catch(() => undefined);

  await query(
    `SELECT add_retention_policy('logs', INTERVAL '1 day' * $1)`,
    [days],
  );
}
