---
name: nodejs-production-dev
description: 'Production-grade Node.js development for lumitrace-ingest. Use when: adding a route, service, middleware, schema, migration, or test; implementing a new feature; reviewing code for production readiness; debugging a service or DB query; refactoring for scalability or security. Stack: Fastify 5, TypeScript, Zod, PostgreSQL/TimescaleDB, JWT (jose), Pino, Vitest.'
argument-hint: 'Describe the feature, fix, or task (e.g. "add DELETE /v1/sources/:id route")'
---

# Node.js Production Developer — lumitrace-ingest

## Project Overview

`lumitrace-ingest` is a production log-ingestion API built with:

| Layer | Technology |
|-------|-----------|
| HTTP framework | Fastify 5 (ESM, Node ≥ 20.11) |
| Language | TypeScript (strict) |
| Validation | Zod — all API boundaries |
| Database | PostgreSQL + TimescaleDB via `pg` (raw SQL, no ORM) |
| Auth | JWT HS256 via `jose`; bcrypt passwords; OTP email verification |
| Pub/Sub | In-process EventEmitter (`src/services/pubsub.ts`) |
| Logging | Pino via Fastify's built-in logger |
| Testing | Vitest |
| Linting | ESLint (zero warnings policy) |

---

## Step-by-Step: Adding a New Feature

### 1. Design the API Contract First
- Define request/response shapes as **Zod schemas** in `src/schemas/index.ts`.
- Use `.strict()` on object schemas to reject unexpected fields.
- Export inferred TypeScript types via `z.infer<typeof MySchemaZ>`.
- All timestamps use `Date` internally; serialize to ISO 8601 in responses.

### 2. Write or Update the Migration (if DB changes needed)
- Add a new file `migrations/NNNN_description.sql`.
- Migrations are run in numeric order via `scripts/migrate.ts`.
- Use TimescaleDB hypertables for any time-series data (see `0003_timescale.sql`).
- Always include a rollback comment block above DDL.
- Never mutate existing migration files — append only.

### 3. Implement the Service Layer
- Place business logic in `src/services/`.
- Services interact with the DB directly via `pool.query<RowType>(sql, params)`.
- **Always use parameterized queries** — never string-interpolate user input into SQL.
- Batch inserts must chunk at 500 rows to stay under PostgreSQL's 65535 parameter cap.
- After DB writes that fan out to subscribers, call `pubsub.publish(sourceId, row)`.
- Export service functions as named exports (not a class instance) unless shared state is required (e.g., `TokenRateLimiter`).

### 4. Add/Update Middleware (if cross-cutting)
- Auth middleware lives in `src/middleware/`. Attach validated identity to `req.user` or `req.source` via Fastify module augmentation.
- Throw typed `AppError` instances from `src/lib/errors.ts` — **never throw raw `Error` or call `reply.send` directly in middleware**.
- Rate-limit state that must persist across requests goes in a service class with a `sweep()` method registered via `setInterval(...).unref()`.

### 5. Register the Route
- Create or update a route file in `src/routes/`.
- Each route file exports one `async function xyzRoutes(app: FastifyInstance): Promise<void>`.
- Register it in `src/app.ts` with `await app.register(xyzRoutes)`.
- Use `preHandler` arrays for auth + rate-limit chaining.
- Validate request bodies and params with `.safeParse()` — throw `errors.badRequest()` on failure, including `v.error.issues[0]?.message` as detail.

### 6. Write Tests
- Test files live in `test/` and are named `*.test.ts`.
- Run with `npm test` (Vitest).
- Test at the unit/service level; integration-test routes via `buildApp()` + `app.inject()`.
- Cover: happy path, validation errors, auth failures, rate-limit edge cases.
- Do **not** hit a real database in unit tests — mock `pool.query`.

### 7. Quality Gates — All Must Pass Before Done
- [ ] `npm run typecheck` — zero TypeScript errors
- [ ] `npm run lint` — zero ESLint warnings or errors
- [ ] `npm test` — all tests green
- [ ] No raw SQL with string interpolation of user input
- [ ] No `any` types unless unavoidable and explicitly suppressed with a comment
- [ ] Response shapes match Zod-inferred types

---

## Coding Standards

### TypeScript
- `strict: true` is enforced — no implicit `any`, no non-null assertion without justification.
- Use `unknown` instead of `any` at trust boundaries; narrow before use.
- Prefer `z.infer<typeof SchemaZ>` for domain types that map to Zod schemas.
- Module system is **ESM** — always include `.js` extension in relative imports.

### Fastify Patterns
```typescript
// Route file skeleton
import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.js';
import { MyRequestBodyZ } from '../schemas/index.js';
import { requireAuth } from '../middleware/auth.js';

export async function myRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/resource', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = MyRequestBodyZ.safeParse(req.body);
    if (!parsed.success) throw errors.badRequest('invalid body', parsed.error.issues[0]?.message);
    // ... call service
    return reply.status(201).send({ id: result.id });
  });
}
```

### Error Handling
- All errors must be `AppError` instances from `src/lib/errors.ts`.
- Add a new factory to `errors` object for new domain error codes.
- The global `errorHandler` in `src/middleware/errorHandler.ts` translates `AppError` → HTTP response. Never bypass it.
- Log at `logger.warn` for expected errors (auth, validation), `logger.error` for unexpected ones.

### Database
- Raw SQL via `pg`. Use `pool.query<RowType>(sql, [params])` for single queries; use the pool client for transactions.
- Define a TS `interface RowType` matching each SELECT's columns.
- Transactions: acquire client from `pool`, wrap in try/catch, always `client.release()` in `finally`.
- All inserts/updates must use `$1, $2, …` placeholders — **zero string concatenation of user data**.

### Config
- All env vars go through the Zod schema in `src/config/index.ts`.
- Fail-fast: invalid config at boot is intentional.
- Never read `process.env` directly outside of `src/config/index.ts`.

### Security Checklist (OWASP)
- **Injection**: parameterized SQL only; Zod validates all input.
- **Auth**: JWT verified with issuer + audience; short-lived access tokens (default 15 min).
- **Sensitive data**: never log passwords, tokens, or OTPs (unless `AUTH_LOG_OTPS=true` in dev).
- **Rate limiting**: global IP limit + per-token ingest limit; auth endpoints rate-limited by IP and email.
- **Headers**: `@fastify/helmet` applied globally.
- **CORS**: explicit origin allowlist via `CORS_ORIGINS` env var.
- **Dependency updates**: flag any new dependency that handles crypto or auth for review.

---

## Project File Map (Quick Reference)

| What | Where |
|------|-------|
| Route handlers | `src/routes/*.ts` |
| Business logic / DB queries | `src/services/*.ts` |
| Auth & ingest middleware | `src/middleware/*.ts` |
| Zod schemas + inferred types | `src/schemas/index.ts` |
| Domain TypeScript types | `src/types/domain.ts` |
| Typed errors | `src/lib/errors.ts` |
| App bootstrap (register plugins/routes) | `src/app.ts` |
| Server entry point | `src/server.ts` |
| DB pool | `src/db/pool.ts` |
| Config (validated env) | `src/config/index.ts` |
| DB migrations | `migrations/NNNN_*.sql` |
| Tests | `test/*.test.ts` |

---

## Common Patterns Reference

### Rate Limiter (per token/entity)
```typescript
const limiter = new TokenRateLimiter(config.INGEST_RATE_PER_TOKEN_PER_MIN);
setInterval(() => limiter.sweep(), 60_000).unref(); // clean up stale buckets
const rl = limiter.hit(entityId);
if (!rl.allowed) throw errors.rateLimited();
```

### Pub/Sub Fan-out (after DB insert)
```typescript
for (const row of res.rows) {
  pubsub.publish(row.source_id, row);
}
```

### Database Transactions (multi-step writes)
```typescript
import { pool } from '../db/pool.js';

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const r1 = await client.query<RowType>('INSERT INTO ...', [params]);
  await client.query('INSERT INTO ...', [r1.rows[0].id, ...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### Email Service (`src/services/emailService.ts`)
- Currently a **stub** — no real transport is wired.
- When implementing a real provider (SMTP/SES/Postmark): add transport config to `src/config/index.ts`, never log email bodies, always handle transport errors as `errors.internal()`, and send non-blocking (do not `await` in the request path unless confirmation is required).
- Outbound emails must never include tokens or OTPs in plaintext log lines.

### Seeding / Scripts
- Seed scripts live in `scripts/` and use `tsx --env-file=.env scripts/seed-xxx.ts`.
- Seed data **must** include `attributes.service`, `attributes.host`, and `attributes.environment` to avoid `"unknown"` appearing in frontend tables.
