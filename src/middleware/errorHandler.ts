/**
 * Translates errors into RFC-7807-ish JSON responses.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    if (err.headers) {
      for (const [name, value] of Object.entries(err.headers)) {
        reply.header(name, value);
      }
    }
    reply.status(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.body ?? {}),
      ...(err.details === undefined ? {} : { details: err.details }),
    });
    return;
  }
  if (err instanceof ZodError) {
    reply.status(400).send({
      error: 'BAD_REQUEST',
      message: 'validation failed',
      details: err.flatten(),
    });
    return;
  }
  // Fastify's own validation / payload-too-large errors expose statusCode
  const fe = err as FastifyError;
  if (typeof fe.statusCode === 'number' && fe.statusCode < 500) {
    reply.status(fe.statusCode).send({ error: fe.code ?? 'BAD_REQUEST', message: err.message });
    return;
  }
  logger.error({ err, reqId: req.id, url: req.url }, 'unhandled error');
  reply.status(500).send({ error: 'INTERNAL', message: 'internal server error' });
}
