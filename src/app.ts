/**
 * Builds the Fastify app — exported so tests can import it without binding a port.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { ingestRoutes } from './routes/ingest.js';
import { streamRoutes } from './routes/stream.js';
import { adminRoutes } from './routes/admin.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.TRUST_PROXY,
    disableRequestLogging: false,
    bodyLimit: config.INGEST_MAX_BODY_BYTES, // ingest is the largest path
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / curl / Vector forwarders won't send Origin — allow them.
      if (!origin) return cb(null, true);
      if (config.CORS_ORIGINS.length === 0) return cb(null, true);
      cb(null, config.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
  });

  // Global IP rate limit as a safety net (per-token limiter lives in the ingest route).
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: 'route not found' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(ingestRoutes);
  await app.register(streamRoutes);
  await app.register(adminRoutes);

  return app;
}
