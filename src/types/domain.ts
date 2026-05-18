/**
 * Domain types shared across services and routes.
 */
export type SourceType = 'pm2' | 'nginx' | 'apache' | 'journald' | 'file' | 'http' | 'docker' | 'laravel' | 'mysql' | 'postgresql' | 'syslog';
export type AlertConditionType = 'keyword' | 'threshold' | 'error_rate';
export type NotifType = 'webhook' | 'slack' | 'email';
export type SourceStatus = 'awaiting' | 'live' | 'stale' | 'error';
export type Severity = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
export type Environment = 'production' | 'staging' | 'dev';

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  environment: Environment;
  color: string;
  created_at: Date;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  is_verified: boolean;
  created_at: Date;
}

export interface EmailOtpRow {
  user_id: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  last_sent_at: Date;
  locked_until: Date | null;
  created_at: Date;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface SourceRow {
  id: string;
  project_id: string;
  name: string;
  type: SourceType;
  config: Record<string, unknown>;
  token_hash: string;
  token_preview: string;
  last_event_at: Date | null;
  status: SourceStatus;
  created_at: Date;
}

export interface LogRow {
  ts: Date;
  id: string;
  source_id: string;
  severity: Severity;
  message: string;
  status_code: number | null;
  attributes: Record<string, unknown>;
  raw: string | null;
}

export interface ApiLog {
  id: string;
  timestamp: string;
  sourceId: string;
  severity: Severity;
  message: string;
  statusCode: number | null;
  attributes: Record<string, unknown>;
  raw: string | null;
  service?: string;
  host?: string;
  environment?: string;
  trace_id?: string;
  span_id?: string;
}

export interface AuthUser {
  id: string;
  email?: string;
  isVerified?: boolean;
  jti?: string;
}

export interface UserSettingsRow {
  user_id: string;
  retention_days: number;
  timezone: string;
  updated_at: Date;
}

export interface AlertRuleRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  enabled: boolean;
  condition_type: AlertConditionType;
  condition: Record<string, unknown>;
  project_id: string | null;
  source_ids: string[];
  notif_type: NotifType;
  notif_config: Record<string, unknown>;
  cooldown_sec: number;
  last_fired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AlertEventRow {
  id: string;
  rule_id: string;
  fired_at: Date;
  details: Record<string, unknown>;
  notified: boolean;
  notif_error: string | null;
}

export interface ServiceStat {
  service: string;
  total: number;
  errors: number;
  lastSeen: string;
}

export interface HostStat {
  host: string;
  total: number;
  errors: number;
  lastSeen: string;
}
