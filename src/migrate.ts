/**
 * Migration runner — compiled to dist/migrate.js and run at container startup
 * before the server process starts. Reads every .sql file in /migrations,
 * applies any not yet recorded in the `_migrations` table, in lexicographic order.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { logger } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function applied(): Promise<Set<string>> {
  const r = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  return new Set(r.rows.map((row) => row.name));
}

async function run(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (done.has(file)) {
      logger.debug({ file }, 'skip applied migration');
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ file }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    logger.info({ file }, 'applied');
  }
  await pool.end();
}

run().catch((err: unknown) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
