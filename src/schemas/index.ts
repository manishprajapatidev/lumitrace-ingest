/**
 * Zod schemas for everything that crosses the API boundary.
 */
import { z } from 'zod';

const SeverityLiteralZ = z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
export const SeverityZ = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(SeverityLiteralZ);
export const SourceTypeZ = z.enum(['pm2', 'nginx', 'apache', 'journald', 'file', 'http', 'docker', 'laravel', 'mysql', 'postgresql', 'syslog']);
export const EnvironmentZ = z.enum(['production', 'staging', 'dev']);

export const CreateProjectZ = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  environment: EnvironmentZ,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be hex like #6366f1')
    .default('#6366f1'),
}).strict();

export const CreateSourceZ = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  type: SourceTypeZ,
  config: z.record(z.string(), z.string()).default({}),
}).strict();

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

export const GlobalLogsQueryZ = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
  sev: z.union([SeverityZ, z.array(SeverityZ)]).optional(),
  sourceId: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(64).optional(),
});

// ── Alert schemas ──────────────────────────────────────────────────────────

export const AlertConditionTypeZ = z.enum(['keyword', 'threshold', 'error_rate']);
export const NotifTypeZ = z.enum(['webhook', 'slack', 'email']);

const KeywordConditionZ = z.object({
  keyword: z.string().min(1).max(200),
  severities: z.array(z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'])).optional(),
});
const ThresholdConditionZ = z.object({
  count: z.number().int().min(1),
  window_sec: z.number().int().min(60).max(86400),
  severities: z.array(z.enum(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'])).optional(),
});
const ErrorRateConditionZ = z.object({
  rate: z.number().min(0).max(1),
  window_sec: z.number().int().min(60).max(86400),
});

export const CreateAlertRuleZ = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  condition_type: AlertConditionTypeZ,
  condition: z.union([KeywordConditionZ, ThresholdConditionZ, ErrorRateConditionZ]),
  project_id: z.string().uuid().optional(),
  source_ids: z.array(z.string().uuid()).default([]),
  notif_type: NotifTypeZ,
  notif_config: z.record(z.string(), z.unknown()).default({}),
  cooldown_sec: z.number().int().min(60).default(300),
}).strict();

export const UpdateAlertRuleZ = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  condition_type: AlertConditionTypeZ.optional(),
  condition: z.union([KeywordConditionZ, ThresholdConditionZ, ErrorRateConditionZ]).optional(),
  project_id: z.string().uuid().nullable().optional(),
  source_ids: z.array(z.string().uuid()).optional(),
  notif_type: NotifTypeZ.optional(),
  notif_config: z.record(z.string(), z.unknown()).optional(),
  cooldown_sec: z.number().int().min(60).optional(),
}).strict();

export const UpdateSettingsZ = z.object({
  retention_days: z.number().int().min(1).max(3650).optional(),
  timezone: z.string().min(1).max(64).optional(),
}).strict();

export const StatsQueryZ = z.object({
  project_id: z.string().uuid().optional(),
  source_ids: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const AlertEventsQueryZ = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});

export const RegisterRequestZ = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(256),
  })
  .strict();

export const VerifyOtpRequestZ = z
  .object({
    email: z.string().trim().email(),
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  })
  .strict();

export const ResendOtpRequestZ = z
  .object({
    email: z.string().trim().email(),
  })
  .strict();

export const LoginRequestZ = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(256),
  })
  .strict();

export const RefreshRequestZ = z
  .object({
    refreshToken: z.string().min(1).max(512),
  })
  .strict();

export const LogoutRequestZ = z
  .object({
    refreshToken: z.string().min(1).max(512).optional(),
  })
  .strict();
