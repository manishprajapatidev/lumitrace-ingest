/**
 * Liveness + readiness probes.
 *  - /healthz: process is alive
 *  - /readyz:  PG is reachable
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await query('SELECT 1');
      return { ok: true };
    } catch {
      reply.status(503);
      return { ok: false };
    }
  });
}
