/**
 * Aggregated service and host statistics derived from the attributes JSONB column.
 * Queries avoid full table scans by pushing as much work as possible into the
 * existing GIN index + time-bounded WHERE clauses.
 */
import { query } from '../db/pool.js';
import type { HostStat, ServiceStat } from '../types/domain.js';

export interface StatsQuery {
  ownerId: string;
  projectId?: string;
  sourceIds?: string[];
  from?: Date;
  to?: Date;
  limit: number;
}

export const statsService = {
  async services(q: StatsQuery): Promise<ServiceStat[]> {
    const { where, params, nextIdx } = buildBaseWhere(q);
    params.push(q.limit);
    const sql = `
      SELECT
        attributes->>'service'                     AS service,
        COUNT(*)::int                              AS total,
        SUM(CASE WHEN severity IN ('ERROR','FATAL') THEN 1 ELSE 0 END)::int AS errors,
        MAX(ts)::text                              AS "lastSeen"
      FROM logs l
      JOIN sources s ON s.id = l.source_id
      JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')}
        AND attributes->>'service' IS NOT NULL
        AND attributes->>'service' <> ''
      GROUP BY attributes->>'service'
      ORDER BY total DESC
      LIMIT $${nextIdx}`;
    const res = await query<{ service: string; total: number; errors: number; lastSeen: string }>(
      sql,
      params as never,
    );
    return res.rows;
  },

  async hosts(q: StatsQuery): Promise<HostStat[]> {
    const { where, params, nextIdx } = buildBaseWhere(q);
    params.push(q.limit);
    const sql = `
      SELECT
        attributes->>'host'                        AS host,
        COUNT(*)::int                              AS total,
        SUM(CASE WHEN severity IN ('ERROR','FATAL') THEN 1 ELSE 0 END)::int AS errors,
        MAX(ts)::text                              AS "lastSeen"
      FROM logs l
      JOIN sources s ON s.id = l.source_id
      JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')}
        AND attributes->>'host' IS NOT NULL
        AND attributes->>'host' <> ''
      GROUP BY attributes->>'host'
      ORDER BY total DESC
      LIMIT $${nextIdx}`;
    const res = await query<{ host: string; total: number; errors: number; lastSeen: string }>(
      sql,
      params as never,
    );
    return res.rows;
  },
};

function buildBaseWhere(q: StatsQuery): {
  where: string[];
  params: unknown[];
  nextIdx: number;
} {
  const where: string[] = ['p.owner_id = $1'];
  const params: unknown[] = [q.ownerId];
  let i = 2;

  if (q.projectId) {
    where.push(`p.id = $${i++}`);
    params.push(q.projectId);
  }
  if (q.sourceIds && q.sourceIds.length > 0) {
    where.push(`l.source_id = ANY($${i++}::uuid[])`);
    params.push(q.sourceIds);
  }
  if (q.from) {
    where.push(`l.ts >= $${i++}`);
    params.push(q.from);
  }
  if (q.to) {
    where.push(`l.ts <= $${i++}`);
    params.push(q.to);
  }
  return { where, params, nextIdx: i };
}
