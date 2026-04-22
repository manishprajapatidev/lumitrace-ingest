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

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<SqlValue> = [],
): Promise<pg.QueryResult<T>> {
  const start = process.hrtime.bigint();
  try {
    const res = await pool.query<T>(text, params as SqlValue[]);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms > 200) logger.warn({ ms, rows: res.rowCount, text: text.slice(0, 80) }, 'slow query');
    return res;
  } catch (err) {
    logger.error({ err, text: text.slice(0, 200) }, 'pg query failed');
    throw err;
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
