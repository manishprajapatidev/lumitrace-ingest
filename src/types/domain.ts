/**
 * Domain types shared across services and routes.
 */
export type SourceType = 'pm2' | 'nginx' | 'apache' | 'journald' | 'file' | 'http';
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

export interface AuthUser {
  id: string;
  email?: string;
}
