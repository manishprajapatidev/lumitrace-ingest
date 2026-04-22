/**
 * Process entrypoint. Boots the Fastify app, wires graceful shutdown +
 * background sweeps, and never lets an unhandled rejection crash silently.
 */
import { buildApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { shutdownPool } from './db/pool.js';
import { sweepStaleSources } from './services/sourceService.js';

async function main(): Promise<void> {
  const app = await buildApp();

  const sweep = setInterval(() => {
    void sweepStaleSources()
      .then((n) => {
        if (n > 0) logger.info({ marked: n }, 'sources marked stale');
        return n;
      })
      .catch((err: unknown) => logger.error({ err }, 'sweepStaleSources failed'));
  }, 60_000);
  sweep.unref();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'lumitrace-ingest started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweep);
    try {
      await app.close();
      await shutdownPool();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
