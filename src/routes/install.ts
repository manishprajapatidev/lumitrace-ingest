/**
 * GET /script/install.sh   — public, serves the installer shell script
 * GET /v1/install/snippets — JWT-auth, returns per-source personalised install commands
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import type { SourceRow } from '../types/domain.js';

// Locate public/install.sh relative to this compiled module file.
// src/routes/ (dev) or dist/routes/ (prod) — both are two levels up from public/.
const _dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(_dirname, '../../public/install.sh');

function readScript(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8');
}

// ── DB ─────────────────────────────────────────────────────────────────────────

interface SourceWithProject extends SourceRow {
  project_name: string;
  project_environment: string;
}

async function listSourcesForOwner(ownerId: string): Promise<SourceWithProject[]> {
  const r = await query<SourceWithProject>(
    `SELECT s.*, p.name AS project_name, p.environment AS project_environment
       FROM sources s
       JOIN projects p ON p.id = s.project_id
      WHERE p.owner_id = $1
      ORDER BY p.created_at DESC, s.created_at DESC`,
    [ownerId],
  );
  return r.rows;
}

// ── snippet builders ────────────────────────────────────────────────────────────

function buildInstallCommand(
  source: SourceWithProject,
  scriptUrl: string,
  ingestUrl: string,
): string {
  const mode = source.type === 'http' ? 'http-push' : 'file-tail';
  const sourceTypeArg = source.type === 'http' ? 'file' : source.type;

  const args = [
    `--mode ${mode}`,
    `--source-type ${sourceTypeArg}`,
    `--ingest-url "${ingestUrl}"`,
    `--ingest-token "<YOUR_SOURCE_TOKEN>"`,
  ];

  if (mode === 'file-tail' && source.type === 'file') {
    args.push('--log-glob "/path/to/your/*.log"');
  }

  args.push('--output json');

  return `curl -fsSL ${scriptUrl} | sudo bash -s -- \\\n  ${args.join(' \\\n  ')}`;
}

function buildCurlExample(ingestUrl: string): string {
  return (
    `curl -X POST '${ingestUrl}' \\\n` +
    `  -H 'Authorization: Bearer <YOUR_SOURCE_TOKEN>' \\\n` +
    `  -H 'Content-Type: application/x-ndjson' \\\n` +
    `  --data-binary $'{"severity":"INFO","message":"hello"}\\n'`
  );
}

function severityNote(sourceType: string): string {
  if (sourceType === 'nginx' || sourceType === 'apache') {
    return 'HTTP status → INFO(1xx/2xx/3xx) WARN(4xx) ERROR(5xx)';
  }
  if (sourceType === 'journald') {
    return 'syslog PRIORITY → FATAL(0-2) ERROR(3) WARN(4) INFO(5-6) DEBUG(7)';
  }
  return 'Keyword scan → FATAL ERROR WARN INFO DEBUG TRACE';
}

// ── Fastify routes ──────────────────────────────────────────────────────────────

export async function installRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /script/install.sh
   * Public — serves the raw installer shell script so customers can pipe into bash.
   */
  app.get('/script/install.sh', async (_req, reply) => {
    reply
      .header('Content-Type', 'text/x-shellscript; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-store')
      .send(readScript());
  });

  /**
   * GET /v1/install/snippets
   * JWT-protected. Returns personalised install commands for every source
   * owned by the authenticated user. Token placeholder is used because
   * plaintext tokens are only shown once at creation/rotation time.
   */
  app.get('/v1/install/snippets', { preHandler: requireAuth }, async (req) => {
    const user = req.user;
    if (!user) throw errors.unauthorized();

    const scriptUrl = `${config.PUBLIC_URL}/script/install.sh`;
    const ingestUrl = `${config.PUBLIC_URL}/v1/ingest`;

    const sources = await listSourcesForOwner(user.id);

    return {
      scriptUrl,
      ingestUrl,
      sources: sources.map((src) => ({
        sourceId: src.id,
        sourceName: src.name,
        sourceType: src.type,
        projectName: src.project_name,
        environment: src.project_environment,
        status: src.status,
        tokenPreview: src.token_preview,
        installCommand: buildInstallCommand(src, scriptUrl, ingestUrl),
        curlExample: buildCurlExample(ingestUrl),
        severityNote: severityNote(src.type),
      })),
    };
  });
}
