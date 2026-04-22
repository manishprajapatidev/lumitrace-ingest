import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { SignJWT } from 'jose';
import { config } from '../config/index.js';
import { sha256 } from './crypto.js';
import { errors } from './errors.js';
import type { UserRow } from '../types/domain.js';

const ACCESS_TOKEN_SECRET = new TextEncoder().encode(config.JWT_SECRET);
const BCRYPT_COST = 12;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertStrongPassword(password: string): void {
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (password.length < config.AUTH_PASSWORD_MIN_LENGTH || !hasLower || !hasUpper || !hasDigit) {
    throw errors.weakPassword();
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateOtpCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return sha256(code);
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export async function signAccessToken(user: Pick<UserRow, 'id' | 'email'>): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(user.id)
    .setJti(randomUUID())
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(ACCESS_TOKEN_SECRET);
}
