# lumitrace-ingest

Production-ready log ingestion API. **Fastify (Node 20) + Postgres/TimescaleDB + SSE live tail.**
Pairs with the Lumitrace frontend (`VITE_API_BASE_URL` points here).

## Architecture

```
Vector / curl / agent  ──► POST /v1/ingest (NDJSON, Bearer <source token>)
                                 │
                                 ▼
                  Zod validate ─► batched INSERT ─► PG/Timescale `logs` hypertable
                                 │
                                 ├─► in-process pub/sub  ──► GET /v1/sources/:id/stream  (SSE)
                                 │
                                 └─► UPDATE sources.last_event_at, status='live'

Frontend (JWT)  ──► GET /v1/sources/:id/logs  (paginated history, keyset cursor)
                ──► POST /v1/sources, /rotate-token, /test-event, …
```

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/v1/ingest` | Bearer source token | NDJSON body, ≤ 1 MB / 1000 lines |
| `GET`  | `/v1/sources/:id/stream` | JWT (header **or** `?token=` for `EventSource`) | SSE, 200-line backfill, 15s heartbeat |
| `GET`  | `/v1/sources/:id/logs` | JWT | `from`,`to`,`q`,`sev[]`,`limit`,`cursor` |
| `POST` | `/v1/projects` | JWT | Create project |
| `GET`  | `/v1/projects` | JWT | List user's projects |
| `DELETE` | `/v1/projects/:id` | JWT | |
| `GET`  | `/v1/projects/:id/sources` | JWT | |
| `POST` | `/v1/sources` | JWT | Returns plaintext `token` once |
| `PATCH` | `/v1/sources/:id` | JWT | name/config |
| `DELETE` | `/v1/sources/:id` | JWT | |
| `POST` | `/v1/sources/:id/rotate-token` | JWT | Returns new token once |
| `POST` | `/v1/sources/:id/test-event` | JWT | End-to-end validation |
| `GET`  | `/healthz`, `/readyz` | – | k8s probes |

## Quick start (local)

```bash
cp .env.example .env
# Bring up Timescale + the API
docker compose up --build -d
# Apply schema
docker compose exec api npm run migrate
# Smoke test
curl http://localhost:8080/healthz
```

## Without Docker

```bash
npm install
# Postgres+TimescaleDB must be reachable at $DATABASE_URL
npm run migrate
npm run dev
```

## Ingest example

```bash
TOKEN=lt_xxxxxxxxxxxxxxxxxxxxxxxx     # from POST /v1/sources
curl -X POST http://localhost:8080/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary $'{"severity":"INFO","message":"hello"}\n{"severity":"ERROR","message":"boom","attributes":{"req_id":"abc"}}\n'
```

Response:
```json
{ "accepted": 2, "rejected": 0, "errors": [] }
```

## Vector forwarder example (PM2)

```toml
[sources.pm2]
type = "file"
include = ["~/.pm2/logs/*.log"]
read_from = "end"

[sinks.lumitrace]
type = "http"
inputs = ["pm2"]
uri = "https://api.example.com/v1/ingest"
encoding.codec = "ndjson"
compression = "gzip"
batch.max_events = 500
batch.timeout_secs = 1
request.headers.Authorization = "Bearer ${LUMITRACE_TOKEN}"
```

## Security model

- **Source tokens** are 32 random bytes (base64url) prefixed with `lt_`. Only the SHA-256 hash is stored. Plaintext is shown once on create / rotate.
- **JWT** for admin/UI routes (HS256 by default — swap to JWKS in `middleware/auth.ts` for OIDC).
- **CORS** enforced on admin/SSE routes; ingest accepts any origin (token is the auth).
- **Rate limit**: per-token (in-memory, sliding 1-minute window) + global IP fallback via `@fastify/rate-limit`.
- **Payload caps**: 1 MB body / 1000 lines / 32 KB per line, enforced before parsing.
- **Validation**: every line through Zod; rejected lines counted + sampled, never indexed.
- **Postgres**: parameterised queries only, no string concatenation, pool with timeouts.

## Configuration

All knobs in `.env` — see `.env.example`. Validated at boot via Zod (`src/config/index.ts`); the process exits if anything's missing or malformed.

## Development

```bash
npm run dev          # tsx watch
npm run lint         # eslint (sonar-aligned rules)
npm run typecheck    # tsc --noEmit
npm run test         # vitest
npm run test:coverage
npm run format       # prettier
```

## Quality gates

- **TypeScript strict** (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.)
- **ESLint flat config** with `@typescript-eslint`, `eslint-plugin-promise`, `eslint-plugin-security`, `eslint-plugin-unicorn` — Sonar Way-aligned (complexity ≤ 15, max-depth 4, no floating promises, eqeqeq, etc.)
- **Prettier** for formatting
- **SonarQube** project file included (`sonar-project.properties`); CI uploads `coverage/lcov.info`.

## Deployment notes

- **Single node**: in-process pubsub + in-memory rate limiter are fine up to ~10k logs/sec on a 4 vCPU box.
- **Horizontal scale**: replace `services/pubsub.ts` with Redis pub/sub and `services/rateLimiter.ts` with `@upstash/ratelimit` (Redis). The interfaces stay identical.
- **Cold storage**: TimescaleDB compression policy fires after 24h, retention drops chunks > 30 days. Tune in `migrations/0001_init.sql`.
- **Long-term**: enable Timescale tiered storage to push old chunks to S3.

## Layout

```
src/
  config/       — Zod-validated env
  db/           — pg pool + tx helper
  lib/          — logger, errors, crypto
  middleware/   — JWT auth, ingest token auth, error handler
  routes/       — health, ingest, stream (SSE), admin (CRUD + history)
  schemas/      — Zod boundary schemas
  services/     — projects, sources, logs, pubsub, rate limiter
  types/        — shared domain types
  app.ts        — Fastify wiring
  server.ts     — process entrypoint (graceful shutdown, sweep)
migrations/     — plain SQL, idempotent
scripts/        — migration runner
test/           — vitest unit tests
```

## License

MIT
