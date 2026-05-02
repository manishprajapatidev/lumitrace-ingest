/**
 * Seed script — pushes 1000 realistic dummy logs across all source types.
 *
 * Usage:
 *   npx tsx scripts/seed-logs.ts \
 *     --token lt_YOUR_INGEST_TOKEN \
 *     --url   http://localhost:8080/v1/ingest \
 *     [--count 1000]
 */
import { randomInt as _randomInt, randomUUID } from 'node:crypto';

// Safe randomInt: handles single-element arrays (max === min)
function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return _randomInt(min, max + 1);
}

// ── CLI args ─────────────────────────────────────────────────────────────────

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument: ${flag}`);
  process.exit(1);
}

const INGEST_URL = arg('--url',   'http://localhost:8080/v1/ingest');
const TOKEN      = arg('--token');
const TOTAL      = parseInt(arg('--count', '1000'), 10);
const BATCH_SIZE = 50;

// ── Data pools ────────────────────────────────────────────────────────────────

type Severity = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

// Weighted severity distribution (realistic — mostly INFO/DEBUG)
const SEVERITY_POOL: Severity[] = [
  'FATAL',
  'ERROR', 'ERROR', 'ERROR',
  'WARN',  'WARN',  'WARN',  'WARN',
  'INFO',  'INFO',  'INFO',  'INFO',  'INFO',  'INFO',  'INFO',  'INFO',
  'DEBUG', 'DEBUG', 'DEBUG', 'DEBUG',
  'TRACE', 'TRACE',
];

const SOURCE_TYPES = ['pm2', 'nginx', 'apache', 'journald', 'file', 'http'] as const;
type SourceType = typeof SOURCE_TYPES[number];

const ENVIRONMENT_POOL = ['production', 'production', 'production', 'staging', 'dev'] as const;

const SERVICE_POOL_BY_SOURCE: Record<SourceType, readonly string[]> = {
  pm2: ['auth-service', 'billing-service', 'worker-cluster', 'api-gateway'],
  nginx: ['edge-nginx', 'ingest-nginx', 'frontend-nginx'],
  apache: ['legacy-apache', 'admin-apache', 'reports-apache'],
  journald: ['sshd', 'nginx', 'postgresql', 'docker', 'systemd', 'cron', 'kernel'],
  file: ['payment-service', 'notification-worker', 'scheduler', 'data-pipeline'],
  http: ['webhook-ingestor', 'track-ingestor', 'events-gateway'],
};

const HOST_POOL_BY_SOURCE: Record<SourceType, readonly string[]> = {
  pm2: ['pm2-1.prod.lumitrace.local', 'pm2-2.prod.lumitrace.local', 'pm2-3.stg.lumitrace.local'],
  nginx: ['edge-01.prod.lumitrace.local', 'edge-02.prod.lumitrace.local', 'edge-01.stg.lumitrace.local'],
  apache: ['legacy-01.prod.lumitrace.local', 'legacy-02.prod.lumitrace.local'],
  journald: ['db.internal', 'node-a.internal', 'node-b.internal', 'unknown-host.internal'],
  file: ['worker-01.prod.lumitrace.local', 'worker-02.prod.lumitrace.local', 'worker-01.stg.lumitrace.local'],
  http: ['ingest-api.prod.lumitrace.local', 'ingest-api.stg.lumitrace.local', 'collector.dev.lumitrace.local'],
};

// ── Message generators per source type ───────────────────────────────────────

function pm2Messages(sev: Severity): { message: string; attributes: object } {
  const maps: Record<Severity, Array<{ message: string; attributes: object }>> = {
    FATAL: [
      { message: 'PM2 process crashed — out of memory', attributes: { pid: randomInt(1000, 9999), heap_mb: 512 } },
      { message: 'FATAL: unhandled exception in cluster worker', attributes: { workerId: randomInt(0, 8) } },
    ],
    ERROR: [
      { message: `Unhandled rejection: Cannot read properties of undefined`, attributes: { stack: 'TypeError at server.js:88' } },
      { message: `Database query failed: connection timeout`, attributes: { query: 'SELECT * FROM users', ms: randomInt(5000, 30000) } },
      { message: `Redis ECONNREFUSED 127.0.0.1:6379`, attributes: { code: 'ECONNREFUSED', retries: randomInt(1, 5) } },
    ],
    WARN: [
      { message: `High memory usage detected`, attributes: { heap_mb: randomInt(380, 490), threshold_mb: 400 } },
      { message: `Slow event loop lag ${randomInt(100, 900)}ms`, attributes: { lag_ms: randomInt(100, 900) } },
      { message: `Rate limit approaching for user`, attributes: { requests: randomInt(80, 99), limit: 100 } },
    ],
    INFO: [
      { message: `GET /api/users 200 ${randomInt(10, 200)}ms`, attributes: { status: 200, method: 'GET', path: '/api/users' } },
      { message: `POST /api/orders 201 ${randomInt(50, 300)}ms`, attributes: { status: 201, method: 'POST', path: '/api/orders' } },
      { message: `Background job completed: send_digest_emails`, attributes: { sent: randomInt(100, 5000) } },
      { message: `Cache hit ratio ${randomInt(85, 99)}%`, attributes: { hits: randomInt(8500, 9900), misses: randomInt(100, 1500) } },
      { message: `Worker ${randomInt(1, 8)} started`, attributes: { pid: randomInt(1000, 9999) } },
    ],
    DEBUG: [
      { message: `Auth token validated`, attributes: { userId: `u_${randomUUID().slice(0, 8)}`, exp: Date.now() + 900000 } },
      { message: `Feature flag evaluated`, attributes: { flag: ['new_checkout', 'dark_mode', 'beta_api'][randomInt(0, 2)], value: true } },
      { message: `DB pool stats`, attributes: { total: 20, idle: randomInt(5, 20), waiting: randomInt(0, 3) } },
    ],
    TRACE: [
      { message: `Entering function processOrder`, attributes: { orderId: `ord_${randomUUID().slice(0, 8)}` } },
      { message: `Middleware chain: auth → validate → handler`, attributes: { duration_us: randomInt(100, 5000) } },
    ],
  };
  const arr = maps[sev];
  return arr[randomInt(0, arr.length - 1)]!;
}

function nginxMessages(sev: Severity): { message: string; attributes: object; status_code?: number } {
  const statusMap: Record<Severity, number[]> = {
    FATAL: [500, 503],
    ERROR: [500, 502, 503, 504],
    WARN:  [400, 401, 403, 404, 429],
    INFO:  [200, 201, 204, 301, 302],
    DEBUG: [200],
    TRACE: [200],
  };
  const codes = statusMap[sev];
  const status_code = codes[randomInt(0, codes.length - 1)]!;
  const paths = ['/api/v1/users', '/api/v1/orders', '/static/app.js', '/healthz', '/api/v1/ingest', '/favicon.ico'];
  const path = paths[randomInt(0, paths.length - 1)];
  const ips = ['1.2.3.4', '192.168.1.10', '10.0.0.5', '203.0.113.42'];
  const ip = ips[randomInt(0, ips.length - 1)];
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  const method = methods[randomInt(0, methods.length - 1)];
  const bytes = randomInt(100, 50000);
  const ms = randomInt(1, 2000);
  return {
    message: `${ip} - - "${method} ${path} HTTP/1.1" ${status_code} ${bytes} ${ms}ms`,
    attributes: { ip, method, path, bytes, response_ms: ms },
    status_code,
  };
}

function apacheMessages(sev: Severity): { message: string; attributes: object; status_code?: number } {
  const statusMap: Record<Severity, number[]> = {
    FATAL: [500, 503],
    ERROR: [500, 502, 503],
    WARN:  [400, 403, 404],
    INFO:  [200, 201, 204, 301],
    DEBUG: [200],
    TRACE: [200],
  };
  const codes = statusMap[sev];
  const status_code = codes[randomInt(0, codes.length - 1)]!;
  const ips = ['1.2.3.4', '172.16.0.1', '203.0.113.10'];
  const ip = ips[randomInt(0, ips.length - 1)];
  const paths = ['/index.html', '/api/data', '/admin/', '/robots.txt', '/wp-login.php'];
  const path = paths[randomInt(0, paths.length - 1)];
  const bytes = randomInt(100, 30000);
  return {
    message: `${ip} - admin [${new Date().toUTCString()}] "GET ${path} HTTP/1.1" ${status_code} ${bytes}`,
    attributes: { ip, path, bytes },
    status_code,
  };
}

function journaldMessages(sev: Severity): { message: string; attributes: object } {
  const priorityMap: Record<Severity, number> = {
    FATAL: randomInt(0, 2),
    ERROR: 3,
    WARN:  4,
    INFO:  randomInt(5, 6),
    DEBUG: 7,
    TRACE: 7,
  };
  const services = ['sshd', 'nginx', 'postgresql', 'docker', 'systemd', 'cron', 'kernel'];
  const service = services[randomInt(0, services.length - 1)]!;
  const msgs: Record<Severity, string[]> = {
    FATAL:  ['Out of memory: Kill process', 'Kernel panic — not syncing'],
    ERROR:  ['Failed to start service', 'Connection refused', 'Segmentation fault'],
    WARN:   ['Disk usage above 80%', 'Too many open files', 'NTP time jump detected'],
    INFO:   ['Started service successfully', 'New connection accepted', 'Configuration reloaded'],
    DEBUG:  ['Timeout check passed', 'Health check ok', 'Socket bound successfully'],
    TRACE:  ['Entering kernel function', 'Syscall traced'],
  };
  const pool = msgs[sev];
  const message = pool[randomInt(0, pool.length - 1)]!;
  return {
    message: `${service}[${randomInt(100, 9999)}]: ${message}`,
    attributes: { service, priority: priorityMap[sev], pid: randomInt(100, 9999) },
  };
}

function fileMessages(sev: Severity): { message: string; attributes: object } {
  const apps = ['payment-service', 'auth-service', 'notification-worker', 'data-pipeline', 'scheduler'];
  const app = apps[randomInt(0, apps.length - 1)]!;
  const msgs: Record<Severity, string[]> = {
    FATAL:  ['FATAL — cannot proceed without config', 'Fatal: database unreachable at startup'],
    ERROR:  ['Error processing batch job', 'Failed to write to output file', 'Exception in thread main'],
    WARN:   ['Retrying failed task (attempt 3/5)', 'File watcher lost track of inode', 'Config missing optional key'],
    INFO:   ['Processing batch 42/100', 'File rotation complete', 'Checkpoint saved successfully'],
    DEBUG:  ['Parsed 1000 records in 200ms', 'Lock acquired on /tmp/app.lock', 'Heap snapshot taken'],
    TRACE:  ['read() called on fd=7', 'Entering loop iteration 88'],
  };
  const pool = msgs[sev];
  const message = pool[randomInt(0, pool.length - 1)]!;
  return {
    message: `[${app}] ${message}`,
    attributes: { app, file: `/var/log/${app}/app.log`, line: randomInt(1, 5000) },
  };
}

function httpMessages(sev: Severity): { message: string; attributes: object } {
  const endpoints = ['/webhook/stripe', '/api/push', '/api/events', '/api/track'];
  const endpoint = endpoints[randomInt(0, endpoints.length - 1)]!;
  const msgs: Record<Severity, string[]> = {
    FATAL:  ['Push ingest endpoint unreachable', 'HTTP push buffer full — dropping events'],
    ERROR:  ['HTTP 500 from upstream webhook', 'Push request rejected: invalid payload'],
    WARN:   ['HTTP push latency high: 4200ms', 'Webhook retry #3 for event evt_abc'],
    INFO:   ['Event received and queued', 'Webhook delivered successfully', 'HTTP push batch accepted'],
    DEBUG:  ['Payload validated against schema', 'Compression ratio: 4.2x'],
    TRACE:  ['HTTP push connection established', 'TLS handshake completed in 12ms'],
  };
  const pool = msgs[sev];
  const message = pool[randomInt(0, pool.length - 1)]!;
  return {
    message: `[http-push] ${endpoint} — ${message}`,
    attributes: { endpoint, method: 'POST', source: 'http-push' },
  };
}

// ── Log line builder ──────────────────────────────────────────────────────────

interface LogLine {
  severity: Severity;
  message: string;
  attributes?: object;
  status_code?: number;
  ts?: string;
}

function buildLogLine(sourceType: SourceType): LogLine {
  const sev = SEVERITY_POOL[randomInt(0, SEVERITY_POOL.length - 1)]!;
  // Spread timestamps over the last 7 days for interesting charts
  const ts = new Date(Date.now() - randomInt(0, 7 * 24 * 60 * 60 * 1000)).toISOString();

  let data: { message: string; attributes: object; status_code?: number };
  switch (sourceType) {
    case 'pm2':      data = pm2Messages(sev);     break;
    case 'nginx':    data = nginxMessages(sev);   break;
    case 'apache':   data = apacheMessages(sev);  break;
    case 'journald': data = journaldMessages(sev); break;
    case 'file':     data = fileMessages(sev);    break;
    case 'http':     data = httpMessages(sev);    break;
  }

  const attrs = data.attributes as Record<string, unknown>;
  const servicePool = SERVICE_POOL_BY_SOURCE[sourceType];
  const hostPool = HOST_POOL_BY_SOURCE[sourceType];
  const service = typeof attrs.service === 'string'
    ? attrs.service
    : servicePool[randomInt(0, servicePool.length - 1)]!;
  const host = typeof attrs.host === 'string'
    ? attrs.host
    : hostPool[randomInt(0, hostPool.length - 1)]!;
  const environment = typeof attrs.environment === 'string'
    ? attrs.environment
    : ENVIRONMENT_POOL[randomInt(0, ENVIRONMENT_POOL.length - 1)]!;

  return {
    severity: sev,
    ts,
    ...data,
    attributes: {
      ...attrs,
      service,
      host,
      environment,
      source_type: sourceType,
    },
  };
}

// ── Batch sender ──────────────────────────────────────────────────────────────

async function sendBatch(lines: LogLine[]): Promise<{ accepted: number; rejected: number }> {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/x-ndjson',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ accepted: number; rejected: number }>;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Seeding ${TOTAL} logs → ${INGEST_URL}`);
  console.log(`Source types: ${SOURCE_TYPES.join(', ')}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  let totalAccepted = 0;
  let totalRejected = 0;
  let generated = 0;

  // Round-robin across source types so each gets an even share
  const sourceTypesCycle = Array.from({ length: TOTAL }, (_, i) => SOURCE_TYPES[i % SOURCE_TYPES.length]!);

  while (generated < TOTAL) {
    const slice = sourceTypesCycle.slice(generated, generated + BATCH_SIZE);
    const lines = slice.map((st) => buildLogLine(st));

    try {
      const result = await sendBatch(lines);
      totalAccepted += result.accepted;
      totalRejected += result.rejected;
      generated += slice.length;

      const pct = Math.round((generated / TOTAL) * 100);
      process.stdout.write(`\r  ${pct}% — ${generated}/${TOTAL} sent  (accepted=${totalAccepted} rejected=${totalRejected})`);
    } catch (err) {
      console.error(`\nBatch failed: ${err}`);
      process.exit(1);
    }
  }

  console.log('\n');
  console.log('Done.');
  console.log(`  Total accepted : ${totalAccepted}`);
  console.log(`  Total rejected : ${totalRejected}`);
  console.log(`  Per source type: ~${Math.round(TOTAL / SOURCE_TYPES.length)} logs each`);
  console.log(`\nView in pgAdmin or query:`);
  console.log(`  SELECT severity, COUNT(*) FROM logs GROUP BY severity ORDER BY COUNT(*) DESC;`);
  console.log(`  SELECT source_type, COUNT(*) FROM sources JOIN logs ON sources.id = logs.source_id GROUP BY source_type;`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
