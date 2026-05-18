/**
 * Aggregated service + host statistics.
 * GET /v1/stats/services — top services by log volume
 * GET /v1/stats/hosts    — top hosts by log volume
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { StatsQueryZ } from '../schemas/index.js';
import { statsService } from '../services/statsService.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/v1/stats/services', async (req) => {
    const q = StatsQueryZ.parse(req.query);
    const sourceIds = q.source_ids
      ? (Array.isArray(q.source_ids) ? q.source_ids : [q.source_ids])
      : undefined;
    return statsService.services({
      ownerId: req.user!.id,
      projectId: q.project_id,
      sourceIds,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
    });
  });

  app.get('/v1/stats/hosts', async (req) => {
    const q = StatsQueryZ.parse(req.query);
    const sourceIds = q.source_ids
      ? (Array.isArray(q.source_ids) ? q.source_ids : [q.source_ids])
      : undefined;
    return statsService.hosts({
      ownerId: req.user!.id,
      projectId: q.project_id,
      sourceIds,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
    });
  });
}
