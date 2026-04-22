import type { PoolClient } from 'pg';
import { constantTimeEquals } from '../lib/crypto.js';
import {
  assertStrongPassword,
  generateOtpCode,
  generateRefreshToken,
  hashOtpCode,
  hashPassword,
  normalizeEmail,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js';
import { config } from '../config/index.js';
import { query, withTx } from '../db/pool.js';
import { errors } from '../lib/errors.js';
import type { EmailOtpRow, RefreshTokenRow, UserRow } from '../types/domain.js';
import { emailService } from './emailService.js';

interface UserOtpLookup extends UserRow {
  code_hash: string | null;
  expires_at: Date | null;
  attempts: number | null;
  last_sent_at: Date | null;
  locked_until: Date | null;
}

interface RefreshLookup extends UserRow {
  refresh_id: string;
  refresh_expires_at: Date;
}

interface AuthUserDto {
  id: string;
  email: string;
  createdAt: string;
  isVerified: boolean;
}

interface SessionResult {
  accessToken: string;
  refreshToken: string;
}

interface SessionWithUser extends SessionResult {
  user: AuthUserDto;
}

function otpExpiryFrom(now: number): Date {
  return new Date(now + config.OTP_TTL_SEC * 1000);
}

function refreshExpiryFrom(now: number): Date {
  return new Date(now + config.REFRESH_TOKEN_TTL_SEC * 1000);
}

function toAuthUser(user: UserRow): AuthUserDto {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.created_at.toISOString(),
    isVerified: user.is_verified,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash, is_verified, created_at
       FROM users
      WHERE email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

async function findUserById(userId: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash, is_verified, created_at
       FROM users
      WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function loadUserOtp(client: PoolClient, email: string): Promise<UserOtpLookup | null> {
  const result = await client.query<UserOtpLookup>(
    `SELECT u.id, u.email, u.password_hash, u.is_verified, u.created_at,
            o.code_hash, o.expires_at, o.attempts, o.last_sent_at, o.locked_until
       FROM users u
       LEFT JOIN email_otps o ON o.user_id = u.id
      WHERE u.email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

async function issueSession(client: PoolClient, user: UserRow): Promise<SessionResult> {
  const now = Date.now();
  const refresh = generateRefreshToken();
  await client.query<RefreshTokenRow>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, refresh.hash, refreshExpiryFrom(now)],
  );
  const accessToken = await signAccessToken(user);
  return { accessToken, refreshToken: refresh.token };
}

async function prepareOtpForUser(
  client: PoolClient,
  user: UserRow,
  options: { enforceCooldown: boolean },
): Promise<{ otpSent: boolean; codeToSend: string | null; expiresAt: Date }> {
  const existingResult = await client.query<EmailOtpRow>(
    `SELECT user_id, code_hash, expires_at, attempts, last_sent_at, locked_until, created_at
       FROM email_otps
      WHERE user_id = $1`,
    [user.id],
  );
  const existing = existingResult.rows[0];
  const now = Date.now();

  if (existing) {
    const retryAfterSec = config.OTP_RESEND_COOLDOWN_SEC - Math.floor((now - existing.last_sent_at.getTime()) / 1000);
    const hasActiveCode = existing.expires_at.getTime() > now;
    if (options.enforceCooldown && retryAfterSec > 0) {
      throw errors.cooldownActive(retryAfterSec);
    }
    if (!options.enforceCooldown && retryAfterSec > 0 && hasActiveCode) {
      return { otpSent: true, codeToSend: null, expiresAt: existing.expires_at };
    }
  }

  const codeToSend = generateOtpCode();
  const expiresAt = otpExpiryFrom(now);
  await client.query(
    `INSERT INTO email_otps (user_id, code_hash, expires_at, attempts, last_sent_at, locked_until)
     VALUES ($1, $2, $3, 0, $4, NULL)
     ON CONFLICT (user_id)
     DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       last_sent_at = EXCLUDED.last_sent_at,
       locked_until = NULL`,
    [user.id, hashOtpCode(codeToSend), expiresAt, new Date(now)],
  );
  return { otpSent: true, codeToSend, expiresAt };
}

export const authService = {
  async register(input: { email: string; password: string }): Promise<{ userId: string; otpSent: true; expiresInSec: number }> {
    const email = normalizeEmail(input.email);
    assertStrongPassword(input.password);
    const existing = await findUserByEmail(email);
    if (existing) throw errors.emailTaken();

    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const otpCode = generateOtpCode();
    const otpHash = hashOtpCode(otpCode);
    const expiresAt = otpExpiryFrom(now);

    try {
      const user = await withTx(async (client) => {
        const insertResult = await client.query<UserRow>(
          `INSERT INTO users (email, password_hash, is_verified)
           VALUES ($1, $2, FALSE)
           RETURNING id, email, password_hash, is_verified, created_at`,
          [email, passwordHash],
        );
        const userRow = insertResult.rows[0];
        if (!userRow) throw errors.internal('failed to create user');
        await client.query(
          `INSERT INTO email_otps (user_id, code_hash, expires_at, attempts, last_sent_at, locked_until)
           VALUES ($1, $2, $3, 0, $4, NULL)`,
          [userRow.id, otpHash, expiresAt, new Date(now)],
        );
        return userRow;
      });
      await emailService.sendOtp(user.email, otpCode, config.OTP_TTL_SEC);
      return { userId: user.id, otpSent: true, expiresInSec: config.OTP_TTL_SEC };
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.emailTaken();
      throw err;
    }
  },

  async verifyOtp(input: { email: string; code: string }): Promise<SessionWithUser> {
    const email = normalizeEmail(input.email);
    return withTx(async (client) => {
      const lookup = await loadUserOtp(client, email);
      if (!lookup || !lookup.code_hash || !lookup.expires_at) throw errors.invalidOtp();

      const now = Date.now();
      if (lookup.locked_until && lookup.locked_until.getTime() > now) {
        throw errors.tooManyAttempts();
      }
      if (lookup.expires_at.getTime() <= now) {
        throw errors.otpExpired();
      }

      const incomingHash = hashOtpCode(input.code);
      if (!constantTimeEquals(lookup.code_hash, incomingHash)) {
        const nextAttempts = (lookup.attempts ?? 0) + 1;
        const lockedUntil =
          nextAttempts >= config.OTP_MAX_ATTEMPTS
            ? new Date(now + config.OTP_LOCKOUT_MIN * 60 * 1000)
            : null;
        await client.query(
          `UPDATE email_otps
              SET attempts = $2,
                  locked_until = $3
            WHERE user_id = $1`,
          [lookup.id, nextAttempts, lockedUntil],
        );
        if (lockedUntil) throw errors.tooManyAttempts();
        throw errors.invalidOtp();
      }

      const userResult = await client.query<UserRow>(
        `UPDATE users
            SET is_verified = TRUE
          WHERE id = $1
          RETURNING id, email, password_hash, is_verified, created_at`,
        [lookup.id],
      );
      const user = userResult.rows[0];
      if (!user) throw errors.internal('failed to verify user');

      await client.query(`DELETE FROM email_otps WHERE user_id = $1`, [lookup.id]);
      const session = await issueSession(client, user);
      return { ...session, user: toAuthUser(user) };
    });
  },

  async resendOtp(input: { email: string }): Promise<{ otpSent: true; cooldownSec: number }> {
    const email = normalizeEmail(input.email);
    const user = await findUserByEmail(email);
    if (!user || user.is_verified) {
      return { otpSent: true, cooldownSec: config.OTP_RESEND_COOLDOWN_SEC };
    }

    const otp = await withTx(async (client) => prepareOtpForUser(client, user, { enforceCooldown: true }));
    if (otp.codeToSend) {
      await emailService.sendOtp(user.email, otp.codeToSend, config.OTP_TTL_SEC);
    }
    return { otpSent: true, cooldownSec: config.OTP_RESEND_COOLDOWN_SEC };
  },

  async login(input: { email: string; password: string }): Promise<SessionWithUser> {
    const email = normalizeEmail(input.email);
    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) throw errors.invalidCredentials();

    const isValid = await verifyPassword(input.password, user.password_hash);
    if (!isValid) throw errors.invalidCredentials();

    if (!user.is_verified) {
      const otp = await withTx(async (client) => prepareOtpForUser(client, user, { enforceCooldown: false }));
      if (otp.codeToSend) {
        await emailService.sendOtp(user.email, otp.codeToSend, config.OTP_TTL_SEC);
      }
      throw errors.emailNotVerified(true);
    }

    const session = await withTx(async (client) => issueSession(client, user));
    return { ...session, user: toAuthUser(user) };
  },

  async refresh(input: { refreshToken: string }): Promise<SessionResult> {
    const tokenHash = hashOtpCode(input.refreshToken);
    const existingResult = await query<RefreshLookup>(
      `SELECT u.id, u.email, u.password_hash, u.is_verified, u.created_at,
              rt.id AS refresh_id,
              rt.expires_at AS refresh_expires_at
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          AND rt.revoked_at IS NULL`,
      [tokenHash],
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.refresh_expires_at.getTime() <= Date.now()) {
      throw errors.invalidRefresh();
    }

    return withTx(async (client) => {
      const revoke = await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = now()
          WHERE id = $1
            AND revoked_at IS NULL`,
        [existing.refresh_id],
      );
      if (revoke.rowCount === 0) throw errors.invalidRefresh();
      return issueSession(client, existing);
    });
  },

  async logout(input: { refreshToken: string }): Promise<void> {
    const tokenHash = hashOtpCode(input.refreshToken);
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE token_hash = $1`,
      [tokenHash],
    );
  },

  async me(userId: string): Promise<AuthUserDto> {
    const user = await findUserById(userId);
    if (!user) throw errors.unauthorized();
    return toAuthUser(user);
  },
};
