-- 0004_backfill_log_metadata.sql
-- One-time data backfill for historical logs that missed normalized metadata.
-- Safe to re-run: only fills missing/blank keys.

WITH candidates AS (
  SELECT
    l.source_id,
    l.ts,
    l.id,
    l.attributes,
    s.name AS source_name,
    s.type AS source_type,
    p.environment AS project_environment
  FROM logs l
  JOIN sources s ON s.id = l.source_id
  JOIN projects p ON p.id = s.project_id
  WHERE
    COALESCE(NULLIF(BTRIM(l.attributes->>'service'), ''), '') = ''
    OR COALESCE(NULLIF(BTRIM(l.attributes->>'host'), ''), '') = ''
    OR COALESCE(NULLIF(BTRIM(l.attributes->>'environment'), ''), '') = ''
    OR COALESCE(NULLIF(BTRIM(l.attributes->>'source_type'), ''), '') = ''
)
UPDATE logs l
SET attributes = c.attributes || jsonb_build_object(
  'service',
  COALESCE(
    NULLIF(BTRIM(c.attributes->>'service'), ''),
    NULLIF(BTRIM(c.attributes->>'app'), ''),
    NULLIF(BTRIM(c.attributes->>'source'), ''),
    NULLIF(BTRIM(c.attributes->>'source_name'), ''),
    c.source_name
  ),
  'host',
  COALESCE(
    NULLIF(BTRIM(c.attributes->>'host'), ''),
    NULLIF(BTRIM(c.attributes->>'hostname'), ''),
    NULLIF(BTRIM(c.attributes->>'ip'), ''),
    CONCAT('source-', LEFT(c.source_id::text, 8), '.internal')
  ),
  'environment',
  COALESCE(
    NULLIF(BTRIM(c.attributes->>'environment'), ''),
    NULLIF(BTRIM(c.attributes->>'env'), ''),
    c.project_environment
  ),
  'source_type',
  COALESCE(
    NULLIF(BTRIM(c.attributes->>'source_type'), ''),
    c.source_type
  )
)
FROM candidates c
WHERE l.source_id = c.source_id
  AND l.ts = c.ts
  AND l.id = c.id;