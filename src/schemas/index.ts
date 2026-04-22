/**
 * Zod schemas for everything that crosses the API boundary.
 */
import { z } from 'zod';

export const SeverityZ = z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
export const SourceTypeZ = z.enum(['pm2', 'nginx', 'apache', 'journald', 'file', 'http']);
export const EnvironmentZ = z.enum(['production', 'staging', 'dev']);

export const CreateProjectZ = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  environment: EnvironmentZ,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be hex like #6366f1')
    .default('#6366f1'),
});

export const CreateSourceZ = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  type: SourceTypeZ,
  config: z.record(z.string(), z.string()).default({}),
});

export const UpdateSourceZ = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * One log line as accepted by /v1/ingest.
 * `ts` may be omitted — we default to receive-time. Anything beyond
 * `INGEST_MAX_LINE_BYTES` is rejected before parsing (see ingest route).
 */
export const IncomingLogZ = z.object({
  ts: z
    .union([z.string().datetime({ offset: true }), z.number().int(), z.date()])
    .optional()
    .transform((v) => {
      if (v === undefined) return new Date();
      if (v instanceof Date) return v;
      if (typeof v === 'number') return new Date(v);
      return new Date(v);
    })
    .refine((d) => !Number.isNaN(d.getTime()), 'invalid timestamp'),
  severity: SeverityZ.default('INFO'),
  message: z.string().min(1).max(32_000),
  status_code: z.number().int().min(0).max(599).optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  raw: z.string().max(32_000).optional(),
});

export type IncomingLog = z.infer<typeof IncomingLogZ>;

export const LogsQueryZ = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
  sev: z.union([SeverityZ, z.array(SeverityZ)]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(64).optional(),
});

export type LogsQuery = z.infer<typeof LogsQueryZ>;
