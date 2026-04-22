/**
 * JWT verification middleware for admin/user routes. Symmetric HS256 by
 * default — swap to JWKS for OIDC providers without changing the route code.
 */
import { jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index.js';
import { errors } from '../lib/errors.js';
import type { AuthUser } from '../types/domain.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req) ?? extractQueryToken(req);
  if (!token) throw errors.unauthorized('missing bearer token');
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw errors.unauthorized('invalid subject');
    }
    req.user = {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('expired')) {
      throw errors.unauthorized('token expired');
    }
    throw errors.unauthorized('invalid token');
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}

/**
 * EventSource cannot send custom headers. Allow `?token=...` for SSE only.
 * Routes that accept this MUST be GETs (idempotent) and rate-limited by user.
 */
function extractQueryToken(req: FastifyRequest): string | null {
  if (req.method !== 'GET') return null;
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q.token === 'string') return q.token;
  return null;
}
