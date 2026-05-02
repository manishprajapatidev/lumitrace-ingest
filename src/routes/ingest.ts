/**
 * /v1/ingest — accepts NDJSON, validates each line, batches into PG, fans out via pubsub.
 *
 * Auth: bearer token (per-source), via requireIngestToken.
 * Body: NDJSON. One JSON log per line. Up to INGEST_MAX_LINES per request.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireIngestToken } from '../middleware/ingestAuth.js';
import { IncomingLogZ } from '../schemas/index.js';
import { insertLogs, type InsertableLog } from '../services/logService.js';
import { TokenRateLimiter } from '../services/rateLimiter.js';
import { sourceService } from '../services/sourceService.js';

const limiter = new TokenRateLimiter(config.INGEST_RATE_PER_TOKEN_PER_MIN);
setInterval(() => limiter.sweep(), 60_000).unref();

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // Override default JSON parser to raw text — body is NDJSON, not JSON.
  app.addContentTypeParser(
    ['application/x-ndjson', 'application/ndjson', 'text/plain'],
    { parseAs: 'string', bodyLimit: config.INGEST_MAX_BODY_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post(
    '/v1/ingest',
    { preHandler: requireIngestToken, bodyLimit: config.INGEST_MAX_BODY_BYTES },
    async (req, reply) => {
      const source = req.source;
      if (!source) throw errors.unauthorized();

      const rl = limiter.hit(source.id);
      reply.header('X-RateLimit-Remaining', String(rl.remaining));
      if (!rl.allowed) {
        reply.header('Retry-After', String(Math.ceil(rl.resetIn / 1000)));
        throw errors.rateLimited();
      }

      const body = typeof req.body === 'string' ? req.body : '';
      if (body.length === 0) {
        return { accepted: 0, rejected: 0, errors: [] };
      }

      const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length > config.INGEST_MAX_LINES) {
        throw errors.payloadTooLarge(`max ${config.INGEST_MAX_LINES} lines per request`);
      }

      const accepted: InsertableLog[] = [];
      const rejected: { line: number; reason: string }[] = [];

      lines.forEach((line, idx) => {
        if (line.length > config.INGEST_MAX_LINE_BYTES) {
          rejected.push({ line: idx, reason: 'line_too_large' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          rejected.push({ line: idx, reason: 'invalid_json' });
          return;
        }
        const v = IncomingLogZ.safeParse(parsed);
        if (!v.success) {
          rejected.push({ line: idx, reason: v.error.issues[0]?.message ?? 'invalid_schema' });
          return;
        }
        const attrs = v.data.attributes as Record<string, unknown>;
        const service = typeof attrs.service === 'string' && attrs.service.length > 0
          ? attrs.service
          : source.name;
        const host = typeof attrs.host === 'string' && attrs.host.length > 0
          ? attrs.host
          : req.ip;
        const environmentFromConfig = source.config?.environment;
        const environment = typeof attrs.environment === 'string' && attrs.environment.length > 0
          ? attrs.environment
          : typeof environmentFromConfig === 'string' && environmentFromConfig.length > 0
            ? environmentFromConfig
            : undefined;

        accepted.push({
          ...v.data,
          source_id: source.id,
          attributes: {
            ...attrs,
            service,
            host,
            source_type: source.type,
            ...(environment ? { environment } : {}),
          },
        });
      });

      if (rejected.length > 0) {
        // Best-effort audit; never blocks the response.
        sourceService
          .recordRejection(
            source.id,
            rejected[0]?.reason ?? 'unknown',
            JSON.stringify(rejected.slice(0, 5)),
          )
          .catch((err: unknown) => logger.warn({ err }, 'rejection log failed'));
      }

      if (accepted.length > 0) {
        await insertLogs(accepted);
        const latest = accepted.reduce(
          (m, r) => (r.ts.getTime() > m.getTime() ? r.ts : m),
          accepted[0]?.ts ?? new Date(),
        );
        sourceService
          .touchLastEvent(source.id, latest)
          .catch((err: unknown) => logger.warn({ err }, 'touchLastEvent failed'));
      }

      return { accepted: accepted.length, rejected: rejected.length, errors: rejected.slice(0, 20) };
    },
  );
}
