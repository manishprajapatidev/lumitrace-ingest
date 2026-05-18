/**
 * Syslog UDP receiver — RFC 3164 and RFC 5424.
 *
 * Bind to SYSLOG_UDP_PORT (default 514, 0 = disabled).
 * Each incoming datagram is parsed to an InsertableLog and persisted via the
 * normal insertLogs path so pubsub fans it out to live-tail subscribers too.
 *
 * Source matching:
 *   The log is attributed to a source whose config.allowedCidrs covers the
 *   sender's IP AND whose type is 'syslog'.  If no match is found the message
 *   is dropped (we never accept unauthenticated data cross-source).
 *   If multiple sources match, the first one wins.
 */
import * as dgram from 'node:dgram';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { insertLogs, type InsertableLog } from './logService.js';
import type { SourceRow } from '../types/domain.js';

// ── Severity mapping ──────────────────────────────────────────────────────────

const SYSLOG_SEVERITY: Record<number, string> = {
  0: 'FATAL', // emerg
  1: 'FATAL', // alert
  2: 'FATAL', // crit
  3: 'ERROR', // err
  4: 'WARN',  // warning
  5: 'INFO',  // notice
  6: 'INFO',  // info
  7: 'DEBUG', // debug
};

// ── Parser ────────────────────────────────────────────────────────────────────

interface ParsedSyslog {
  facility: number;
  severity: string;
  hostname: string;
  appName: string;
  message: string;
  ts: Date;
  raw: string;
}

function parsePri(raw: string): { pri: number; rest: string } | null {
  const m = raw.match(/^<(\d{1,3})>(.*)/s);
  if (!m) return null;
  const pri = parseInt(m[1]!, 10);
  if (pri < 0 || pri > 191) return null;
  return { pri, rest: m[2]! };
}

function parseRfc5424(msg: string, pri: number, rest: string): ParsedSyslog | null {
  // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG
  const m = rest.match(
    /^(\d+) (\S+) (\S+) (\S+) (\S+) (\S+) (\[.*?\]|-) ?(.*)/s,
  );
  if (!m || m[1] !== '1') return null;
  const ts = m[2] === '-' ? new Date() : new Date(m[2]!);
  if (Number.isNaN(ts.getTime())) return null;
  return {
    facility: pri >> 3,
    severity: SYSLOG_SEVERITY[pri & 0x07] ?? 'INFO',
    hostname: m[3] === '-' ? '' : m[3]!,
    appName: m[4] === '-' ? '' : m[4]!,
    message: m[8]?.trim() ?? '',
    ts,
    raw: msg,
  };
}

function parseRfc3164(msg: string, pri: number, rest: string): ParsedSyslog {
  // TIMESTAMP HOSTNAME TAG: MSG
  // MMM DD HH:MM:SS or ISO
  let ts: Date;
  let body = rest;

  const dateMatch = rest.match(
    /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/s,
  );
  if (dateMatch) {
    const year = new Date().getFullYear();
    ts = new Date(`${dateMatch[1]!} ${year}`);
    if (Number.isNaN(ts.getTime())) ts = new Date();
    body = dateMatch[2]!;
  } else {
    ts = new Date();
  }

  const hostMatch = body.match(/^(\S+)\s+(.*)/s);
  const hostname = hostMatch ? hostMatch[1]! : '';
  const remainder = hostMatch ? hostMatch[2]! : body;
  const tagMatch = remainder.match(/^(\S+?):\s*(.*)/s);
  const appName = tagMatch ? tagMatch[1]! : '';
  const message = tagMatch ? tagMatch[2]!.trim() : remainder.trim();

  return {
    facility: pri >> 3,
    severity: SYSLOG_SEVERITY[pri & 0x07] ?? 'INFO',
    hostname,
    appName,
    message: message || remainder.trim(),
    ts,
    raw: msg,
  };
}

function parseDatagram(buf: Buffer): ParsedSyslog | null {
  const msg = buf.toString('utf8').trim();
  if (!msg) return null;
  const parsed = parsePri(msg);
  if (!parsed) return null;
  return parseRfc5424(msg, parsed.pri, parsed.rest) ?? parseRfc3164(msg, parsed.pri, parsed.rest);
}

// ── Source resolution cache (refreshed every 60 s) ───────────────────────────

let syslogSourcesCache: SourceRow[] = [];
let cacheLoadedAt = 0;

async function getSyslogSources(): Promise<SourceRow[]> {
  if (Date.now() - cacheLoadedAt < 60_000) return syslogSourcesCache;
  const r = await query<SourceRow>(`SELECT * FROM sources WHERE type = 'syslog'`, []);
  syslogSourcesCache = r.rows;
  cacheLoadedAt = Date.now();
  return syslogSourcesCache;
}

function ipMatchesCidrs(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true; // open — accept all IPs
  // Simple prefix match (supports x.x.x.x/prefix notation)
  return cidrs.some((cidr) => {
    if (!cidr.includes('/')) return cidr === ip;
    const [base, bits] = cidr.split('/');
    const mask = ~((1 << (32 - parseInt(bits ?? '32', 10))) - 1) >>> 0;
    const ipNum = ipToNum(ip);
    const baseNum = ipToNum(base ?? '');
    return (ipNum & mask) === (baseNum & mask);
  });
}

function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

async function resolveSource(remoteIp: string): Promise<SourceRow | null> {
  const sources = await getSyslogSources();
  for (const s of sources) {
    const cidrs = (s.config as { allowedCidrs?: string[] }).allowedCidrs ?? [];
    if (ipMatchesCidrs(remoteIp, cidrs)) return s;
  }
  return null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startSyslogReceiver(): dgram.Socket | null {
  if (config.SYSLOG_UDP_PORT === 0) {
    logger.info('syslog UDP receiver disabled (SYSLOG_UDP_PORT=0)');
    return null;
  }

  const sock = dgram.createSocket('udp4');

  sock.on('message', (buf, rinfo) => {
    handleDatagram(buf, rinfo.address).catch((err: unknown) =>
      logger.warn({ err, remote: rinfo.address }, 'syslog datagram error'),
    );
  });

  sock.on('error', (err) => {
    logger.error({ err }, 'syslog UDP socket error');
  });

  sock.bind(config.SYSLOG_UDP_PORT, config.SYSLOG_UDP_HOST, () => {
    logger.info({ port: config.SYSLOG_UDP_PORT }, 'syslog UDP receiver listening');
  });

  return sock;
}

async function handleDatagram(buf: Buffer, remoteIp: string): Promise<void> {
  const parsed = parseDatagram(buf);
  if (!parsed || !parsed.message) return;

  const source = await resolveSource(remoteIp).catch(() => null);
  if (!source) {
    logger.debug({ remoteIp }, 'syslog: no matching source for IP — dropped');
    return;
  }

  const log: InsertableLog = {
    ts: parsed.ts,
    severity: parsed.severity as InsertableLog['severity'],
    message: parsed.message,
    source_id: source.id,
    attributes: {
      host: parsed.hostname || remoteIp,
      service: parsed.appName || source.name,
      facility: parsed.facility,
      syslog_severity: parsed.severity,
      source_type: 'syslog',
    },
    raw: parsed.raw,
  };

  await insertLogs([log]);
}
