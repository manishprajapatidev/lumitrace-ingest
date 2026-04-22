import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import {
  LoginRequestZ,
  LogoutRequestZ,
  RefreshRequestZ,
  RegisterRequestZ,
  ResendOtpRequestZ,
  VerifyOtpRequestZ,
} from '../schemas/index.js';
import { authService } from '../services/authService.js';
import { TokenRateLimiter } from '../services/rateLimiter.js';

const ipLimiter = new TokenRateLimiter(config.AUTH_RATE_IP_PER_MIN);
const emailLimiter = new TokenRateLimiter(
  config.AUTH_RATE_EMAIL_PER_WINDOW,
  config.AUTH_RATE_EMAIL_WINDOW_SEC * 1000,
);
setInterval(() => {
  ipLimiter.sweep();
  emailLimiter.sweep();
}, 60_000).unref();

function applyRateLimit(reply: FastifyReply, result: { allowed: boolean; remaining: number; resetIn: number }): void {
  reply.header('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    reply.header('Retry-After', String(Math.ceil(result.resetIn / 1000)));
    throw errors.rateLimited();
  }
}

function requestIp(req: FastifyRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

function extractBearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const match = /^Bearer\s+(.+)$/i.exec(h);
  return match?.[1] ?? null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/auth/register', async (req, reply) => {
    const body = RegisterRequestZ.parse(req.body);
    applyRateLimit(reply, ipLimiter.hit(`register:ip:${requestIp(req)}`));
    applyRateLimit(reply, emailLimiter.hit(`register:email:${emailKey(body.email)}`));
    const result = await authService.register(body);
    reply.status(201).send(result);
  });

  app.post('/v1/auth/verify-otp', async (req) => {
    const body = VerifyOtpRequestZ.parse(req.body);
    return authService.verifyOtp(body);
  });

  app.post('/v1/auth/resend-otp', async (req, reply) => {
    const body = ResendOtpRequestZ.parse(req.body);
    applyRateLimit(reply, ipLimiter.hit(`resend:ip:${requestIp(req)}`));
    applyRateLimit(reply, emailLimiter.hit(`resend:email:${emailKey(body.email)}`));
    return authService.resendOtp(body);
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const body = LoginRequestZ.parse(req.body);
    applyRateLimit(reply, ipLimiter.hit(`login:ip:${requestIp(req)}`));
    applyRateLimit(reply, emailLimiter.hit(`login:email:${emailKey(body.email)}`));
    return authService.login(body);
  });

  app.post('/v1/auth/refresh', async (req) => {
    const body = RefreshRequestZ.parse(req.body);
    return authService.refresh(body);
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const body = LogoutRequestZ.parse(req.body ?? {});
    const refreshToken = body.refreshToken ?? extractBearerToken(req);
    if (!refreshToken) throw errors.invalidRefresh();
    await authService.logout({ refreshToken });
    reply.status(204).send();
  });

  app.get('/v1/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = req.user;
    if (!user) throw errors.unauthorized();
    return authService.me(user.id);
  });
}
