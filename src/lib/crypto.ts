/**
 * Crypto helpers. Tokens are 32 random bytes encoded as base64url with a
 * short prefix; we store only the SHA-256 hash. Comparing hashes is constant-time.
 */
import { randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config/index.js';

export function generateToken(): { token: string; hash: string; preview: string } {
  const raw = randomBytes(config.TOKEN_BYTES).toString('base64url');
  const token = `${config.TOKEN_PREFIX}_${raw}`;
  const hash = sha256(token);
  const preview = `${token.slice(0, 8)}…${token.slice(-4)}`;
  return { token, hash, preview };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newId(): string {
  return randomUUID();
}
