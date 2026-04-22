/**
 * Bearer-token auth for the ingest endpoint. Resolves token -> source row.
 * Constant-time via hash compare in sourceService.resolveByToken.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { sourceService } from '../services/sourceService.js';
import type { SourceRow } from '../types/domain.js';

declare module 'fastify' {
  interface FastifyRequest {
    source?: SourceRow;
  }
}

export async function requireIngestToken(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  const token = m?.[1];
  if (!token) throw errors.unauthorized('missing bearer token');
  const src = await sourceService.resolveByToken(token);
  if (!src) throw errors.unauthorized('invalid token');
  req.source = src;
}
