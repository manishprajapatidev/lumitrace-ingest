/**
 * Centralized, validated configuration. Reads process.env once at boot
 * and exposes a strongly-typed, frozen `config` object. Failing fast on
 * invalid configuration is intentional — never run with bad config.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  PG_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().min(1).default('lumitrace'),
  JWT_AUDIENCE: z.string().min(1).default('lumitrace-api'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(3600).default(2_592_000),
  AUTH_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  AUTH_RATE_IP_PER_MIN: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_EMAIL_PER_WINDOW: z.coerce.number().int().min(1).default(5),
  AUTH_RATE_EMAIL_WINDOW_SEC: z.coerce.number().int().min(60).default(900),
  OTP_TTL_SEC: z.coerce.number().int().min(60).default(600),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().min(1).default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  OTP_LOCKOUT_MIN: z.coerce.number().int().min(1).default(15),
  AUTH_LOG_OTPS: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  INGEST_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  INGEST_MAX_LINES: z.coerce.number().int().min(1).default(1000),
  INGEST_MAX_LINE_BYTES: z.coerce.number().int().min(256).default(32_768),
  INGEST_RATE_PER_TOKEN_PER_MIN: z.coerce.number().int().min(1).default(3000),

  TOKEN_BYTES: z.coerce.number().int().min(16).max(64).default(32),
  TOKEN_PREFIX: z.string().min(1).max(8).default('lt'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    process.stderr.write(`Invalid configuration:\n${issues}\n`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const config: AppConfig = loadConfig();
