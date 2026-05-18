# Copilot Instructions — lumitrace-ingest

This is a **production log-ingestion API** (Fastify 5, TypeScript, PostgreSQL/TimescaleDB). All code must be production-grade. Apply the following conventions on every task.

---

## Language & Module System

- TypeScript `strict: true` is enforced — no implicit `any`, no unused variables.
- Module system is **ESM**. All relative imports must include the `.js` extension (even for `.ts` source files).
- Target Node.js ≥ 20.11. Use native `crypto.randomUUID()`, `fetch`, and `structuredClone` — no polyfills needed.

## Validation

- **Every** value that crosses an API boundary (request body, query param, env var, DB row used as response) must be validated with **Zod** before use.
- Schemas live in `src/schemas/index.ts`. Object schemas use `.strict()` to reject unknown fields.
- Export TypeScript types via `z.infer<typeof SchemaZ>` — do not hand-write parallel types for schema-derived shapes.

## Database

- Use `query<RowType>(sql, [params])` from `src/db/pool.ts` for single statements.
- Use `withTx(async (client) => { ... })` from `src/db/pool.ts` for multi-statement transactions — never manage `BEGIN/COMMIT/ROLLBACK` manually.
- **No string interpolation of user-supplied data into SQL** — parameterized placeholders (`$1`, `$2`, …) only.
- Batch inserts must chunk at ≤ 500 rows to stay under PostgreSQL's 65535 parameter cap.
- After inserts that need live fan-out, call `pubsub.publish(sourceId, row)` for each row.

## Error Handling

- Throw only `AppError` instances from `src/lib/errors.ts`. Never throw raw `Error` or call `reply.send()` directly inside middleware or services.
- The global error handler in `src/middleware/errorHandler.ts` handles all translation to HTTP — do not duplicate that logic.
- Log expected errors (auth, validation, rate-limit) at `logger.warn`. Log unexpected errors at `logger.error`.

## Auth & Security

- JWT verification uses `jwtVerify` from `jose` with issuer + audience checks — do not skip either.
- Passwords hashed with `bcrypt` via helpers in `src/lib/auth.ts` — never call `bcrypt` directly from routes or services.
- **Never log** passwords, tokens, OTP codes (unless `AUTH_LOG_OTPS=true` which is dev-only), or PII.
- All routes that mutate data must have `requireAuth` or `requireIngestToken` as `preHandler`.
- New ingest-path code must account for the per-token `TokenRateLimiter` before processing.

## Configuration

- Read config exclusively from the validated `config` object in `src/config/index.ts`.
- Never read `process.env` directly anywhere else.
- New env vars must be added to the Zod schema in `src/config/index.ts` with appropriate type coercion and defaults.

## Fastify Conventions

- Each route file exports one `async function xyzRoutes(app: FastifyInstance): Promise<void>`.
- Register all route plugins in `src/app.ts` with `await app.register(xyzRoutes)`.
- Use `preHandler` arrays for chaining auth + rate-limit middleware.
- Do not call `reply.send()` and also `return` a value — pick one per handler.

## Code Style

- No `any` types. Use `unknown` at trust boundaries and narrow before use.
- No dead code, no commented-out blocks in committed files.
- Named exports only — no default exports (except for Fastify plugins where the framework requires it).
- Keep services free of HTTP concerns (`req`, `reply`, status codes). Services receive plain values and return plain values or throw `AppError`.

## Testing

- Tests live in `test/*.test.ts` and run with `npm test` (Vitest).
- Unit tests mock `pool.query` — do not hit a real database.
- Integration tests use `buildApp()` + `app.inject()` to exercise full request/response cycles.
- Every new route must have at minimum: happy path, auth failure (401), and validation failure (400) test cases.

## Quality Gates — Required Before Any PR

```
npm run typecheck   # zero TypeScript errors
npm run lint        # zero ESLint warnings
npm test            # all tests pass
```
