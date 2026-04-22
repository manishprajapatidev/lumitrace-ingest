/**
 * Project + Source persistence layer. Pure SQL, no Fastify-isms.
 */
import { query, withTx } from '../db/pool.js';
import { generateToken, sha256 } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import type { ProjectRow, SourceRow, SourceType, Environment } from '../types/domain.js';

export const projectService = {
  async list(ownerId: string): Promise<ProjectRow[]> {
    const r = await query<ProjectRow>(
      `SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId],
    );
    return r.rows;
  },

  async create(
    ownerId: string,
    input: { name: string; description: string; environment: Environment; color: string },
  ): Promise<ProjectRow> {
    const r = await query<ProjectRow>(
      `INSERT INTO projects (owner_id, name, description, environment, color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ownerId, input.name, input.description, input.environment, input.color],
    );
    const row = r.rows[0];
    if (!row) throw errors.internal('failed to create project');
    return row;
  },

  async getOwned(ownerId: string, projectId: string): Promise<ProjectRow> {
    const r = await query<ProjectRow>(`SELECT * FROM projects WHERE id = $1 AND owner_id = $2`, [
      projectId,
      ownerId,
    ]);
    const row = r.rows[0];
    if (!row) throw errors.notFound('project not found');
    return row;
  },

  async remove(ownerId: string, projectId: string): Promise<void> {
    const r = await query(`DELETE FROM projects WHERE id = $1 AND owner_id = $2`, [projectId, ownerId]);
    if (r.rowCount === 0) throw errors.notFound('project not found');
  },
};

export const sourceService = {
  async listForProject(ownerId: string, projectId: string): Promise<SourceRow[]> {
    await projectService.getOwned(ownerId, projectId); // ownership check
    const r = await query<SourceRow>(
      `SELECT * FROM sources WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return r.rows;
  },

  /**
   * Creates a source AND mints its first ingest token.
   * Returns the row plus the plaintext token (only chance to read it).
   */
  async create(
    ownerId: string,
    input: { projectId: string; name: string; type: SourceType; config: Record<string, string> },
  ): Promise<{ source: SourceRow; token: string }> {
    await projectService.getOwned(ownerId, input.projectId);
    const { token, hash, preview } = generateToken();
    const r = await query<SourceRow>(
      `INSERT INTO sources (project_id, name, type, config, token_hash, token_preview)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING *`,
      [input.projectId, input.name, input.type, JSON.stringify(input.config), hash, preview],
    );
    const source = r.rows[0];
    if (!source) throw errors.internal('failed to create source');
    return { source, token };
  },

  async getOwned(ownerId: string, sourceId: string): Promise<SourceRow> {
    const r = await query<SourceRow>(
      `SELECT s.* FROM sources s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND p.owner_id = $2`,
      [sourceId, ownerId],
    );
    const row = r.rows[0];
    if (!row) throw errors.notFound('source not found');
    return row;
  },

  async update(
    ownerId: string,
    sourceId: string,
    patch: { name?: string; config?: Record<string, string> },
  ): Promise<SourceRow> {
    await this.getOwned(ownerId, sourceId);
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(patch.name);
    }
    if (patch.config !== undefined) {
      sets.push(`config = $${i++}::jsonb`);
      params.push(JSON.stringify(patch.config));
    }
    if (sets.length === 0) return this.getOwned(ownerId, sourceId);
    params.push(sourceId);
    const r = await query<SourceRow>(
      `UPDATE sources SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params as never,
    );
    const row = r.rows[0];
    if (!row) throw errors.internal('update failed');
    return row;
  },

  async remove(ownerId: string, sourceId: string): Promise<void> {
    await this.getOwned(ownerId, sourceId);
    await query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
  },

  async rotateToken(ownerId: string, sourceId: string): Promise<{ token: string; preview: string }> {
    await this.getOwned(ownerId, sourceId);
    const { token, hash, preview } = generateToken();
    await query(`UPDATE sources SET token_hash = $1, token_preview = $2 WHERE id = $3`, [
      hash,
      preview,
      sourceId,
    ]);
    return { token, preview };
  },

  /**
   * Resolve a presented bearer token to a source. Constant-time via hash equality.
   */
  async resolveByToken(token: string): Promise<SourceRow | null> {
    const hash = sha256(token);
    const r = await query<SourceRow>(`SELECT * FROM sources WHERE token_hash = $1`, [hash]);
    return r.rows[0] ?? null;
  },

  async touchLastEvent(sourceId: string, ts: Date): Promise<void> {
    await query(
      `UPDATE sources
         SET last_event_at = GREATEST(COALESCE(last_event_at, $2), $2),
             status = 'live'
       WHERE id = $1`,
      [sourceId, ts],
    );
  },

  async recordRejection(sourceId: string | null, reason: string, sample: string): Promise<void> {
    await query(`INSERT INTO ingest_rejections(source_id, reason, sample) VALUES ($1, $2, $3)`, [
      sourceId,
      reason,
      sample.slice(0, 1000),
    ]);
  },
};

/**
 * Background sweep — call from a cron / setInterval — flips sources to `stale`
 * if no event in 10 minutes.
 */
export async function sweepStaleSources(): Promise<number> {
  return withTx(async (c) => {
    const r = await c.query(
      `UPDATE sources
          SET status = 'stale'
        WHERE status = 'live'
          AND (last_event_at IS NULL OR last_event_at < now() - INTERVAL '10 minutes')`,
    );
    return r.rowCount ?? 0;
  });
}
