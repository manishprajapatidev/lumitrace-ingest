/**
 * Alert rule CRUD + event history.
 * All routes require a valid JWT (requireAuth hook on the plugin).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  AlertEventsQueryZ,
  CreateAlertRuleZ,
  UpdateAlertRuleZ,
} from '../schemas/index.js';
import { alertService } from '../services/alertService.js';

const IdParamZ = z.object({ id: z.string().uuid() });

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List all rules for the authenticated user.
  app.get('/v1/alerts', async (req) => {
    return alertService.list(req.user!.id);
  });

  // Create a new rule.
  app.post('/v1/alerts', async (req, reply) => {
    const body = CreateAlertRuleZ.parse(req.body);
    const rule = await alertService.create(req.user!.id, {
      ...body,
      condition: body.condition as Record<string, unknown>,
      notif_config: body.notif_config as Record<string, unknown>,
    });
    reply.status(201).send(rule);
  });

  // Get a single rule (ownership verified inside service).
  app.get<{ Params: { id: string } }>('/v1/alerts/:id', async (req) => {
    const { id } = IdParamZ.parse(req.params);
    return alertService.getOwned(req.user!.id, id);
  });

  // Partial update.
  app.patch<{ Params: { id: string } }>('/v1/alerts/:id', async (req) => {
    const { id } = IdParamZ.parse(req.params);
    const patch = UpdateAlertRuleZ.parse(req.body);
    return alertService.update(req.user!.id, id, {
      ...patch,
      condition: patch.condition as Record<string, unknown> | undefined,
      notif_config: patch.notif_config as Record<string, unknown> | undefined,
    });
  });

  // Delete a rule.
  app.delete<{ Params: { id: string } }>('/v1/alerts/:id', async (req, reply) => {
    const { id } = IdParamZ.parse(req.params);
    await alertService.remove(req.user!.id, id);
    reply.status(204).send();
  });

  // Firing history for a specific rule (cursor-paginated).
  app.get<{ Params: { id: string } }>('/v1/alerts/:id/events', async (req) => {
    const { id } = IdParamZ.parse(req.params);
    await alertService.getOwned(req.user!.id, id); // ownership check
    const q = AlertEventsQueryZ.parse(req.query);
    const events = await alertService.listEvents(id, q.limit, q.cursor);
    return { events };
  });
}
