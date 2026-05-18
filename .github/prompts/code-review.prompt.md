---
name: code-review
description: 'Security-focused production code review for lumitrace-ingest. Use when reviewing a route, service, middleware, schema, or migration for correctness, security, and adherence to project conventions.'
argument-hint: 'Paste the file path or code to review, or describe what changed'
---

Perform a thorough production code review of the provided code in the context of the `lumitrace-ingest` project. Evaluate against every checklist item below and report findings grouped by severity.

## Severity Levels

- **BLOCKER** — Must fix before merge. Security vulnerability, data loss risk, or correctness bug.
- **WARNING** — Should fix. Convention violation, missing test coverage, or subtle risk.
- **SUGGESTION** — Nice to fix. Code quality, readability, or future maintainability.

---

## Security Checklist (OWASP Top 10)

### Injection (A03)
- [ ] All SQL uses parameterized placeholders (`$1`, `$2`, …) — zero string interpolation of user data.
- [ ] All user-supplied input is parsed through a Zod schema before use.
- [ ] No `eval`, `new Function`, or dynamic `require`/`import` with user input.

### Broken Authentication (A07)
- [ ] JWT verification calls `jwtVerify` with both `issuer` and `audience` options set.
- [ ] Passwords are hashed via helpers in `src/lib/auth.ts` — bcrypt never called directly.
- [ ] OTP codes are compared via `constantTimeEquals` from `src/lib/crypto.ts` to prevent timing attacks.
- [ ] Access tokens are short-lived (`ACCESS_TOKEN_TTL_SEC`, default 15 min).

### Sensitive Data Exposure (A02)
- [ ] No passwords, tokens, or OTP codes written to logs (unless `AUTH_LOG_OTPS=true` dev flag).
- [ ] No PII (email, IP) logged at `info` or above without a clear operational justification.
- [ ] Response bodies do not leak password hashes, internal IDs, or stack traces.

### Security Misconfiguration (A05)
- [ ] No new env vars read from `process.env` directly — must go through `src/config/index.ts`.
- [ ] New env vars have appropriate Zod type coercion and safe defaults.
- [ ] No secrets or credentials hardcoded in source.

### Broken Access Control (A01)
- [ ] All mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) have `requireAuth` or `requireIngestToken` in `preHandler`.
- [ ] Service functions do not trust caller-supplied `userId`/`sourceId` without verifying ownership.
- [ ] Admin-only operations check for admin role / elevated auth.

### Rate Limiting & DoS (A04)
- [ ] Ingest path hits `TokenRateLimiter` before processing any log lines.
- [ ] Auth endpoints (login, register, OTP) are protected by per-IP and per-email rate limits.
- [ ] Batch inputs (NDJSON lines, bulk operations) have enforced size caps.

---

## Correctness Checklist

### Error Handling
- [ ] Only `AppError` instances are thrown — no raw `new Error(...)` in routes/services/middleware.
- [ ] `reply.send()` and `return value` are not both used in the same handler.
- [ ] No `try/catch` that silently swallows errors (catch must at minimum log or rethrow).
- [ ] Expected errors logged at `logger.warn`; unexpected at `logger.error`.

### Database
- [ ] Multi-step writes wrapped in `withTx(async (client) => { ... })` — no manual `BEGIN/COMMIT`.
- [ ] Batch inserts chunked at ≤ 500 rows.
- [ ] `pool.query` result rows typed with a concrete `interface RowType` — no untyped `any`.
- [ ] After inserts with live subscribers, `pubsub.publish(sourceId, row)` called per row.

### Validation
- [ ] Request body, path params, and query params all validated with Zod before use.
- [ ] DB rows used in responses validated or explicitly typed — no raw row passthrough.
- [ ] No hand-written types that duplicate a Zod schema — use `z.infer<typeof SchemaZ>`.

---

## Code Style & Conventions

- [ ] Module system: all relative imports end in `.js`.
- [ ] No `any` types — `unknown` used at trust boundaries and narrowed before use.
- [ ] No dead code or commented-out blocks.
- [ ] Named exports only (no default exports except Fastify plugins).
- [ ] Services are free of HTTP concerns (`req`, `reply`, status codes).
- [ ] Route file exports exactly one `async function xyzRoutes(app: FastifyInstance)`.
- [ ] New route registered in `src/app.ts` with `await app.register(...)`.

---

## Test Coverage

- [ ] Happy-path test exists.
- [ ] Auth failure (401) test exists for protected routes.
- [ ] Validation failure (400) test exists.
- [ ] Rate-limit behavior tested if a new limiter is introduced.
- [ ] Unit tests mock `pool.query` — no real DB connections.

---

## Migration Review (if applicable)

- [ ] New migration file is numbered correctly (`NNNN_description.sql`).
- [ ] Rollback steps documented as a comment block at the top of the file.
- [ ] No existing migration files modified — append-only.
- [ ] TimescaleDB hypertable used for any new time-series table.
- [ ] No nullable columns added without a `DEFAULT` to avoid locking the table.

---

## Output Format

For each finding:

```
[SEVERITY] <file>:<line-range> — <short description>
  Why: <why this is a problem>
  Fix: <concrete recommendation>
```

End with a summary section:
- Total blockers / warnings / suggestions
- Overall verdict: **APPROVE**, **REQUEST CHANGES**, or **NEEDS DISCUSSION**
