/**
 * SSE live tail.  GET /v1/sources/:id/stream
 *
 * Sends an initial backfill (most recent N lines), then every new event for
 * this source as `data: <json>\n\n`. 15s heartbeat keeps proxies happy.
 */
import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchHistory, toApiLog } from '../services/logService.js';
import { pubsub } from '../services/pubsub.js';
import { sourceService } from '../services/sourceService.js';
import type { ApiLog, LogRow } from '../types/domain.js';

const HEARTBEAT_MS = 15_000;
const BACKFILL = 200;

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/sources/:id/stream',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user;
      if (!user) throw errors.unauthorized();
      const sourceId = req.params.id;
      await sourceService.getOwned(user.id, sourceId); // ownership

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`retry: 3000\n\n`);

      const sendApiLog = (event: ApiLog): void => {
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (err) {
          logger.warn({ err, sourceId }, 'sse write failed');
        }
      };
      const send = (event: LogRow): void => sendApiLog(toApiLog(event));

      // Backfill — newest at top so the client can prepend.
      try {
        const hist = await fetchHistory({ sourceId, limit: BACKFILL });
        for (const row of [...hist.logs].reverse()) sendApiLog(row);
      } catch (err) {
        logger.warn({ err, sourceId }, 'sse backfill failed');
      }

      const unsubscribe = pubsub.subscribe(sourceId, send);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: ping ${Date.now()}\n\n`);
        } catch {
          /* socket likely closed */
        }
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          /* noop */
        }
      };

      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);

      // Tell Fastify we'll write the response ourselves.
      return reply;
    },
  );
}
