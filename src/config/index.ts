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
