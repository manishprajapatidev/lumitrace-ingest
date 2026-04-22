/**
 * Log persistence + history queries. Batched parameterised inserts.
 */
import { Buffer } from 'node:buffer';
import { pool, query } from '../db/pool.js';
import type { IncomingLog } from '../schemas/index.js';
import type { LogRow, Severity } from '../types/domain.js';
import { pubsub } from './pubsub.js';

export interface InsertableLog extends IncomingLog {
  source_id: string;
}

/**
 * Batch insert. Splits into chunks of 500 to keep parameter count under PG's 65535 cap.
 */
export async function insertLogs(rows: InsertableLog[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    inserted += await insertChunk(chunk);
  }
  return inserted;
}

async function insertChunk(rows: InsertableLog[]): Promise<number> {
  const cols = ['ts', 'source_id', 'severity', 'message', 'status_code', 'attributes', 'raw'];
  const values: unknown[] = [];
  const placeholders: string[] = [];
  rows.forEach((r, i) => {
    const o = i * cols.length;
    placeholders.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}::jsonb, $${o + 7})`,
    );
    values.push(
      r.ts,
      r.source_id,
      r.severity,
      r.message,
      r.status_code ?? null,
      JSON.stringify(r.attributes ?? {}),
      r.raw ?? null,
    );
  });
  const sql = `INSERT INTO logs (${cols.join(', ')}) VALUES ${placeholders.join(', ')}
               RETURNING ts, id, source_id, severity, message, status_code, attributes, raw`;
  const res = await pool.query<LogRow>(sql, values);
  for (const row of res.rows) {
    pubsub.publish(row.source_id, row);
  }
  return res.rowCount ?? 0;
}

export interface HistoryQuery {
  sourceId: string;
  from?: Date;
  to?: Date;
  q?: string;
  severities?: Severity[];
  limit: number;
  /** Keyset cursor `<isoTs>_<id>`. Returns rows STRICTLY OLDER than this. */
  cursor?: string;
}

export interface HistoryResult {
  logs: LogRow[];
  nextCursor?: string;
}

export async function fetchHistory(q: HistoryQuery): Promise<HistoryResult> {
  const where: string[] = ['source_id = $1'];
  const params: unknown[] = [q.sourceId];
  let i = 2;

  if (q.from) {
    where.push(`ts >= $${i++}`);
    params.push(q.from);
  }
  if (q.to) {
    where.push(`ts <= $${i++}`);
    params.push(q.to);
  }
  if (q.q) {
    where.push(`message ILIKE $${i++}`);
    params.push(`%${q.q}%`);
  }
  if (q.severities && q.severities.length > 0) {
    where.push(`severity = ANY($${i++}::text[])`);
    params.push(q.severities);
  }
  if (q.cursor) {
    const parsed = parseCursor(q.cursor);
    if (parsed) {
      where.push(`(ts, id) < ($${i++}, $${i++})`);
      params.push(parsed.ts, parsed.id);
    }
  }

  params.push(q.limit + 1);
  const sql = `SELECT ts, id, source_id, severity, message, status_code, attributes, raw
                 FROM logs
                WHERE ${where.join(' AND ')}
                ORDER BY ts DESC, id DESC
                LIMIT $${i}`;

  const res = await query<LogRow>(sql, params as never);
  const rows = res.rows;
  const hasMore = rows.length > q.limit;
  const sliced = hasMore ? rows.slice(0, q.limit) : rows;
  const last = sliced[sliced.length - 1];
  const nextCursor = hasMore && last ? makeCursor(last.ts, last.id) : undefined;
  return { logs: sliced, nextCursor };
}

function makeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

function parseCursor(c: string): { ts: Date; id: string } | null {
  try {
    const decoded = Buffer.from(c, 'base64url').toString('utf8');
    const idx = decoded.indexOf('|');
    if (idx < 0) return null;
    const ts = new Date(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    if (Number.isNaN(ts.getTime()) || !id) return null;
    return { ts, id };
  } catch {
    return null;
  }
}
