/**
 * User settings: GET + PATCH /v1/settings
 * Controls retention policy and timezone.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { UpdateSettingsZ } from '../schemas/index.js';
import { settingsService } from '../services/settingsService.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/v1/settings', async (req) => {
    return settingsService.get(req.user!.id);
  });

  app.patch('/v1/settings', async (req) => {
    const patch = UpdateSettingsZ.parse(req.body);
    return settingsService.update(req.user!.id, patch);
  });
}
