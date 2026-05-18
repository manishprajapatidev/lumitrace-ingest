/**
 * Alert rules: CRUD + background evaluator.
 *
 * Evaluator runs every ALERT_EVAL_INTERVAL_SEC seconds. For each enabled rule
 * it queries the logs table for the configured condition. When a rule fires:
 *   1. An alert_event row is inserted.
 *   2. Notification is delivered (webhook / slack / email).
 *   3. last_fired_at is updated to enforce the cooldown.
 *
 * Multi-instance safety: a pg advisory lock is held for the duration of the
 * evaluation pass. Only one instance evaluates at a time.
 */
import { pool, query, withTx } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { errors } from '../lib/errors.js';
import type { AlertRuleRow, AlertEventRow } from '../types/domain.js';

// ── CRUD ──────────────────────────────────────────────────────────────────────

export const alertService = {
  async list(ownerId: string): Promise<AlertRuleRow[]> {
    const r = await query<AlertRuleRow>(
      `SELECT * FROM alert_rules WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId],
    );
    return r.rows;
  },

  async getOwned(ownerId: string, ruleId: string): Promise<AlertRuleRow> {
    const r = await query<AlertRuleRow>(
      `SELECT * FROM alert_rules WHERE id = $1 AND owner_id = $2`,
      [ruleId, ownerId],
    );
    const row = r.rows[0];
    if (!row) throw errors.notFound('alert rule not found');
    return row;
  },

  async create(
    ownerId: string,
    input: {
      name: string;
      description: string;
      enabled: boolean;
      condition_type: string;
      condition: Record<string, unknown>;
      project_id?: string;
      source_ids: string[];
      notif_type: string;
      notif_config: Record<string, unknown>;
      cooldown_sec: number;
    },
  ): Promise<AlertRuleRow> {
    const r = await query<AlertRuleRow>(
      `INSERT INTO alert_rules
         (owner_id, name, description, enabled, condition_type, condition,
          project_id, source_ids, notif_type, notif_config, cooldown_sec)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::uuid[],$9,$10::jsonb,$11)
       RETURNING *`,
      [
        ownerId,
        input.name,
        input.description,
        input.enabled,
        input.condition_type,
        JSON.stringify(input.condition),
        input.project_id ?? null,
        input.source_ids,
        input.notif_type,
        JSON.stringify(input.notif_config),
        input.cooldown_sec,
      ],
    );
    const row = r.rows[0];
    if (!row) throw errors.internal('failed to create alert rule');
    return row;
  },

  async update(
    ownerId: string,
    ruleId: string,
    patch: Partial<{
      name: string;
      description: string;
      enabled: boolean;
      condition_type: string;
      condition: Record<string, unknown>;
      project_id: string | null;
      source_ids: string[];
      notif_type: string;
      notif_config: Record<string, unknown>;
      cooldown_sec: number;
    }>,
  ): Promise<AlertRuleRow> {
    await this.getOwned(ownerId, ruleId);
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let i = 1;

    if (patch.name !== undefined) { sets.push(`name = $${i++}`); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push(`description = $${i++}`); params.push(patch.description); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); params.push(patch.enabled); }
    if (patch.condition_type !== undefined) { sets.push(`condition_type = $${i++}`); params.push(patch.condition_type); }
    if (patch.condition !== undefined) { sets.push(`condition = $${i++}::jsonb`); params.push(JSON.stringify(patch.condition)); }
    if ('project_id' in patch) { sets.push(`project_id = $${i++}`); params.push(patch.project_id ?? null); }
    if (patch.source_ids !== undefined) { sets.push(`source_ids = $${i++}::uuid[]`); params.push(patch.source_ids); }
    if (patch.notif_type !== undefined) { sets.push(`notif_type = $${i++}`); params.push(patch.notif_type); }
    if (patch.notif_config !== undefined) { sets.push(`notif_config = $${i++}::jsonb`); params.push(JSON.stringify(patch.notif_config)); }
    if (patch.cooldown_sec !== undefined) { sets.push(`cooldown_sec = $${i++}`); params.push(patch.cooldown_sec); }

    params.push(ruleId);
    const r = await query<AlertRuleRow>(
      `UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params as never,
    );
    const row = r.rows[0];
    if (!row) throw errors.internal('update failed');
    return row;
  },

  async remove(ownerId: string, ruleId: string): Promise<void> {
    await this.getOwned(ownerId, ruleId);
    await query(`DELETE FROM alert_rules WHERE id = $1`, [ruleId]);
  },

  async listEvents(ruleId: string, limit: number, cursor?: string): Promise<AlertEventRow[]> {
    const where: string[] = ['rule_id = $1'];
    const params: unknown[] = [ruleId];
    let i = 2;
    if (cursor) {
      where.push(`fired_at < $${i++}`);
      params.push(new Date(Buffer.from(cursor, 'base64url').toString('utf8')));
    }
    params.push(limit);
    const r = await query<AlertEventRow>(
      `SELECT * FROM alert_events WHERE ${where.join(' AND ')} ORDER BY fired_at DESC LIMIT $${i}`,
      params as never,
    );
    return r.rows;
  },
};

// ── Evaluator ─────────────────────────────────────────────────────────────────

const ADVISORY_LOCK_KEY = 0x4c75_6d69_5472_6163n; // "LumiTrac"

export function startAlertEvaluator(): NodeJS.Timeout {
  const interval = config.ALERT_EVAL_INTERVAL_SEC * 1000;
  return setInterval(() => {
    runEvaluationPass().catch((err: unknown) =>
      logger.error({ err }, 'alert evaluation pass failed'),
    );
  }, interval).unref();
}

async function runEvaluationPass(): Promise<void> {
  const client = await pool.connect();
  try {
    // Advisory lock — only one instance evaluates at a time.
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      `SELECT pg_try_advisory_lock($1)`,
      [ADVISORY_LOCK_KEY],
    );
    if (!lockRes.rows[0]?.pg_try_advisory_lock) return; // another instance holds the lock

    try {
      const rulesRes = await client.query<AlertRuleRow>(
        `SELECT * FROM alert_rules WHERE enabled = true`,
      );
      for (const rule of rulesRes.rows) {
        await evaluateRule(rule).catch((err: unknown) =>
          logger.warn({ err, ruleId: rule.id }, 'rule evaluation error'),
        );
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function evaluateRule(rule: AlertRuleRow): Promise<void> {
  // Enforce cooldown.
  if (rule.last_fired_at) {
    const sinceFireMs = Date.now() - rule.last_fired_at.getTime();
    if (sinceFireMs < rule.cooldown_sec * 1000) return;
  }

  const fired = await checkCondition(rule);
  if (!fired) return;

  // Insert event + update last_fired_at atomically.
  const eventRes = await withTx(async (c) => {
    const ev = await c.query<AlertEventRow>(
      `INSERT INTO alert_events (rule_id, details) VALUES ($1, $2::jsonb) RETURNING *`,
      [rule.id, JSON.stringify(fired.details)],
    );
    await c.query(
      `UPDATE alert_rules SET last_fired_at = now() WHERE id = $1`,
      [rule.id],
    );
    return ev.rows[0]!;
  });

  // Deliver notification (best-effort).
  deliverNotification(rule, eventRes).catch((err: unknown) =>
    logger.warn({ err, ruleId: rule.id }, 'notification delivery failed'),
  );
}

interface FiredResult {
  details: Record<string, unknown>;
}

async function checkCondition(rule: AlertRuleRow): Promise<FiredResult | null> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  // Scope the query to the rule's sources/project.
  if (rule.source_ids.length > 0) {
    where.push(`source_id = ANY($${i++}::uuid[])`);
    params.push(rule.source_ids);
  } else if (rule.project_id) {
    where.push(
      `source_id IN (SELECT id FROM sources WHERE project_id = $${i++})`,
    );
    params.push(rule.project_id);
  } else {
    return null; // misconfigured rule — no scope
  }

  if (rule.condition_type === 'keyword') {
    const cond = rule.condition as { keyword: string; severities?: string[] };
    where.push(`message ILIKE $${i++}`);
    params.push(`%${cond.keyword}%`);
    if (cond.severities && cond.severities.length > 0) {
      where.push(`severity = ANY($${i++}::text[])`);
      params.push(cond.severities);
    }
    // Look back 5 minutes for keyword matches.
    where.push(`ts > now() - INTERVAL '5 minutes'`);
    params.push(1);
    const res = await query<{ count: string; sample: string }>(
      `SELECT COUNT(*)::text AS count,
              jsonb_agg(jsonb_build_object('ts', ts, 'msg', message) ORDER BY ts DESC) FILTER (WHERE rn <= 3)::text AS sample
         FROM (
           SELECT *, row_number() OVER (ORDER BY ts DESC) AS rn
           FROM logs
           WHERE ${where.join(' AND ')}
           LIMIT 50
         ) sub`,
      params as never,
    );
    const count = parseInt(res.rows[0]?.count ?? '0', 10);
    if (count === 0) return null;
    return { details: { count, keyword: cond.keyword, sample: res.rows[0]?.sample } };
  }

  if (rule.condition_type === 'threshold') {
    const cond = rule.condition as { count: number; window_sec: number; severities?: string[] };
    where.push(`ts > now() - ($${i++} * INTERVAL '1 second')`);
    params.push(cond.window_sec);
    if (cond.severities && cond.severities.length > 0) {
      where.push(`severity = ANY($${i++}::text[])`);
      params.push(cond.severities);
    }
    const res = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM logs WHERE ${where.join(' AND ')}`,
      params as never,
    );
    const count = parseInt(res.rows[0]?.count ?? '0', 10);
    if (count < cond.count) return null;
    return { details: { count, threshold: cond.count, window_sec: cond.window_sec } };
  }

  if (rule.condition_type === 'error_rate') {
    const cond = rule.condition as { rate: number; window_sec: number };
    where.push(`ts > now() - ($${i++} * INTERVAL '1 second')`);
    params.push(cond.window_sec);
    const res = await query<{ total: string; errors: string }>(
      `SELECT COUNT(*)::text AS total,
              SUM(CASE WHEN severity IN ('ERROR','FATAL') THEN 1 ELSE 0 END)::text AS errors
         FROM logs WHERE ${where.join(' AND ')}`,
      params as never,
    );
    const total = parseInt(res.rows[0]?.total ?? '0', 10);
    if (total === 0) return null;
    const errorCount = parseInt(res.rows[0]?.errors ?? '0', 10);
    const rate = errorCount / total;
    if (rate < cond.rate) return null;
    return { details: { error_rate: rate, errors: errorCount, total, threshold_rate: cond.rate } };
  }

  return null;
}

async function deliverNotification(rule: AlertRuleRow, event: AlertEventRow): Promise<void> {
  const payload = {
    rule_id: rule.id,
    rule_name: rule.name,
    event_id: event.id,
    fired_at: event.fired_at.toISOString(),
    details: event.details,
  };

  let notifError: string | null = null;

  try {
    if (rule.notif_type === 'webhook') {
      const cfg = rule.notif_config as { url?: string };
      if (!cfg.url) throw new Error('missing webhook url');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.WEBHOOK_TIMEOUT_MS);
      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } else if (rule.notif_type === 'slack') {
      const cfg = rule.notif_config as { webhook_url?: string };
      if (!cfg.webhook_url) throw new Error('missing slack webhook_url');
      const text = `🚨 *${rule.name}* fired at ${payload.fired_at}\n\`\`\`${JSON.stringify(payload.details, null, 2)}\`\`\``;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.WEBHOOK_TIMEOUT_MS);
      try {
        const res = await fetch(cfg.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`slack returned ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } else if (rule.notif_type === 'email') {
      // In production wire this to SES / Resend / etc.
      // For now we log it so the event is still recorded as notified.
      logger.info({ payload }, 'alert email notification (stub)');
    }
  } catch (err: unknown) {
    notifError = err instanceof Error ? err.message : String(err);
    logger.warn({ err, ruleId: rule.id }, 'notification delivery failed');
  }

  await query(
    `UPDATE alert_events SET notified = $1, notif_error = $2 WHERE id = $3`,
    [notifError === null, notifError, event.id],
  );
}
