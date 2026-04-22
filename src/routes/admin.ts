/**
 * Admin/user CRUD + history routes. All require a valid JWT.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import {
  CreateProjectZ,
  CreateSourceZ,
  IncomingLogZ,
  LogsQueryZ,
  UpdateSourceZ,
} from '../schemas/index.js';
import { fetchHistory, insertLogs } from '../services/logService.js';
import { projectService, sourceService } from '../services/sourceService.js';

const IdParamZ = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // --- projects -------------------------------------------------------------
  app.get('/v1/projects', async (req) => {
    const user = req.user!;
    return projectService.list(user.id);
  });

  app.post('/v1/projects', async (req) => {
    const user = req.user!;
    const body = CreateProjectZ.parse(req.body);
    return projectService.create(user.id, body);
  });

  app.delete<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    await projectService.remove(user.id, id);
    reply.status(204).send();
  });

  // --- sources --------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id/sources',
    async (req) => {
      const user = req.user!;
      const { id } = IdParamZ.parse(req.params);
      return sourceService.listForProject(user.id, id);
    },
  );

  app.post('/v1/sources', async (req) => {
    const user = req.user!;
    const body = CreateSourceZ.parse(req.body);
    const { source, token } = await sourceService.create(user.id, body);
    // token is only returned here — the hash is what we keep.
    return { ...source, token };
  });

  app.patch<{ Params: { id: string } }>('/v1/sources/:id', async (req) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    const patch = UpdateSourceZ.parse(req.body);
    return sourceService.update(user.id, id, patch);
  });

  app.delete<{ Params: { id: string } }>('/v1/sources/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    await sourceService.remove(user.id, id);
    reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/sources/:id/rotate-token', async (req) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    const { token, preview } = await sourceService.rotateToken(user.id, id);
    return { token, tokenPreview: preview };
  });

  /**
   * Fires a synthetic line through the real ingest path so the user can
   * verify their setup end-to-end from the UI.
   */
  app.post<{ Params: { id: string } }>('/v1/sources/:id/test-event', async (req) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    const src = await sourceService.getOwned(user.id, id);
    const log = IncomingLogZ.parse({
      severity: 'INFO',
      message: `Test event from ${user.email ?? user.id} at ${new Date().toISOString()}`,
      attributes: { test: true, source_name: src.name },
    });
    const inserted = await insertLogs([{ ...log, source_id: src.id }]);
    if (inserted === 0) throw errors.internal('test event not persisted');
    await sourceService.touchLastEvent(src.id, log.ts);
    return { ok: true, receivedAt: log.ts.getTime() };
  });

  // --- history --------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/sources/:id/logs', async (req) => {
    const user = req.user!;
    const { id } = IdParamZ.parse(req.params);
    await sourceService.getOwned(user.id, id);
    const q = LogsQueryZ.parse(req.query);
    const sevs = q.sev ? (Array.isArray(q.sev) ? q.sev : [q.sev]) : undefined;
    const result = await fetchHistory({
      sourceId: id,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      q: q.q,
      severities: sevs,
      limit: q.limit,
      cursor: q.cursor,
    });
    return result;
  });
}
