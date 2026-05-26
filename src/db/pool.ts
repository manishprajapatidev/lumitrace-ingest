/**
 * Postgres connection pool wrapper. All queries go through `query` so
 * we get consistent logging + timing + error handling.
 */
import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: config.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
  application_name: 'lumitrace-ingest',
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle PG client error');
});

export type SqlValue = string | number | boolean | Date | null | object;

function compactSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<SqlValue> = [],
): Promise<pg.QueryResult<T>> {
  const start = process.hrtime.bigint();
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    const acquiredAt = process.hrtime.bigint();
    const res = await client.query<T>(text, params as SqlValue[]);
    const finishedAt = process.hrtime.bigint();

    const waitMs = Number(acquiredAt - start) / 1e6;
    const execMs = Number(finishedAt - acquiredAt) / 1e6;
    const totalMs = Number(finishedAt - start) / 1e6;
    if (totalMs > 200) {
      const sql = compactSql(text);
      logger.warn(
        {
          ms: totalMs,
          waitMs,
          execMs,
          rows: res.rowCount,
          text: sql.length > 240 ? `${sql.slice(0, 240)}...` : sql,
        },
        'slow query',
      );
    }
    return res;
  } catch (err) {
    const sql = compactSql(text);
    logger.error({ err, text: sql.length > 400 ? `${sql.slice(0, 400)}...` : sql }, 'pg query failed');
    throw err;
  } finally {
    client?.release();
  }
}

/**
 * Run multiple statements in a single transaction. Rolls back on any throw.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function shutdownPool(): Promise<void> {
  await pool.end();
}
