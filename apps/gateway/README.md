# `@caliber/gateway`

Fastify data-plane server exposing `/v1/messages` (Anthropic-native) and
`/v1/chat/completions` (OpenAI-compatible). Part of Plan 4A, ships in
**v0.3.0**.

- User + operator guide: [`../../docs/GATEWAY.md`](../../docs/GATEWAY.md)
- Self-host bring-up: [`../../docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md) §6
- Design doc: [`../../.claude/plans/2026-04-20-plan4a-gateway-design.md`](../../.claude/plans/2026-04-20-plan4a-gateway-design.md)

This README is for engineers working **on** the gateway (dev loop, tests,
debugging). Everything user-facing lives in `GATEWAY.md`.

---

## Prerequisites

- Node 20+, pnpm 9+
- Docker (for integration tests via testcontainers)
- A Postgres connection string (shared with `apps/api`) and a local Redis for
  ad-hoc runs — the usual `docker compose up postgres redis` from the
  repo-root `docker/` works.

The workspace packages this depends on:

- `@caliber/config` — `parseServerEnv`, `ServerEnv`. Every env var the gateway
  reads is validated here.
- `@caliber/db` — shared schema, Drizzle client, migrations.
- `@caliber/gateway-core` — pricing table, OpenAI↔Anthropic translation,
  error-classifier state machine, state-machine + pricing helpers.

---

## Dev loop

From the repo root:

```sh
# Boot Postgres + Redis (leave running in a separate shell)
docker compose -f docker/docker-compose.yml up -d postgres redis

# Run migrations once against the local DB
pnpm --filter @caliber/db migrate

# Dev server with tsx watch
pnpm --filter @caliber/gateway dev
```

`dev` uses `tsx watch` on `src/server.ts` — save-triggered reload.

Environment for local dev is read from `process.env`; export the gateway
vars before you start, e.g.:

```sh
export ENABLE_GATEWAY=true
export GATEWAY_BASE_URL=http://localhost:3002
export REDIS_URL=redis://localhost:6379
export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
export API_KEY_HASH_PEPPER=$(openssl rand -hex 32)
export DATABASE_URL=postgresql://aide:aide@localhost:5432/aide
# …plus the rest of the @caliber/config server schema (AUTH_SECRET, OAuth creds,
# BOOTSTRAP_*, NEXTAUTH_URL). A `direnv` .envrc at the repo root is the usual
# pattern.
```

Quick smoke:

```sh
curl -s localhost:3002/health
# {"status":"ok"}   when ENABLE_GATEWAY=true
# {"status":"disabled"}   otherwise

curl -s localhost:3002/metrics | head
# Prometheus exposition
```

---

## Tests

The test pyramid mirrors `apps/api`:

| Command | What it runs | Needs |
|---|---|---|
| `pnpm --filter @caliber/gateway test` | Unit tests (vitest) | Nothing external — uses `ioredis-mock` and in-memory fakes |
| `pnpm --filter @caliber/gateway test:integration` | Integration tests (vitest + testcontainers) | Docker daemon running |
| `pnpm --filter @caliber/gateway-core test` | Pure-logic tests from the shared core | Nothing external |

**Unit tests** live in `src/**/*.test.ts`. They exercise routing, middleware,
and runtime helpers against mocked Redis (`ioredis-mock`) and an in-memory
Drizzle stub where needed. They should pass in milliseconds.

**Integration tests** live in `tests/integration/`. They start throwaway
Postgres and Redis containers via `@testcontainers/postgresql` +
`@testcontainers/redis`, run the real migrations, boot a real `buildServer`,
and drive it end-to-end. The fake Anthropic upstream server (see below)
stands in for the real API.

> **Note — BullMQ vs `ioredis-mock`.** BullMQ uses Lua scripts that
> `ioredis-mock` doesn't implement. Tests that pass an `ioredis-mock`
> instance via `buildServer({ env, redis })` intentionally **skip** queue /
> worker / billing-audit wiring (see the `BuildOpts.redis` doc block in
> `src/server.ts`). Tests that need real BullMQ lifecycle coverage live in
> `tests/integration/` and stand up a real Redis container.

### Faking the Anthropic upstream

Integration tests spin up a real HTTP server (`createServer` from
`node:http`) on an ephemeral port and point `UPSTREAM_ANTHROPIC_BASE_URL`
at it. Each suite defines its own request handler so scenarios stay local
and obvious — see `apps/gateway/tests/routes/messages.integration.test.ts`
for the non-streaming shape and
`messages.streaming.integration.test.ts` for SSE framing, mid-stream
disconnects, and TCP reset behaviour.

Why a real server rather than intercepting fetch with `nock`: `nock` sits
at the Node fetch layer and skips undici's TCP / HTTP/1.1 / SSE framing
code. `AbortSignal` propagation, the smart-buffer 500 ms window, and
partial-chunk SSE parsing can only be validated against real sockets.

A shared, scenario-parameterised fake-upstream harness (as described in the
design doc's Section 7.3) is a post-4A cleanup — not shipped in v0.3.0.

---

## Debugging

### Log levels

`LOG_LEVEL` env var drives the pino logger. `debug` surfaces the per-attempt
failover decisions, Redis command round-trips, and the inline OAuth refresh
flow. Pair with `pino-pretty` in dev:

```sh
LOG_LEVEL=debug pnpm --filter @caliber/gateway dev 2>&1 | pnpm dlx pino-pretty
```

Credentials and raw API keys are **never** logged — the request logger
redacts them. If you need to see them during an investigation, add a
one-off `console.debug` locally and remove before committing (a lint rule
will flag stray `console.log` on PRs).

### Redis inspection

The gateway uses the `aide:gw:` key prefix (via `ioredis` `keyPrefix`). To
see what's there:

```sh
docker compose exec redis redis-cli --scan --pattern 'aide:gw:*' | head
# Shapes shipped in 4A (see apps/gateway/src/redis/keys.ts for the single
# source of truth — ioredis prepends the `aide:gw:` prefix automatically):
#   aide:gw:slots:account:{accountId}   — per-account concurrency slot
#   aide:gw:slots:user:{userId}         — per-user concurrency slot
#   aide:gw:state:account:{accountId}   — cached account state snapshot
#   aide:gw:oauth-refresh:{accountId}   — per-account OAuth refresh lock
#   aide:gw:key-reveal:{token}          — one-time URL reveal token (EXPIRE 86400)
#   aide:gw:usage-log:*                 — BullMQ queue internals (see below)
#
# `aide:gw:{wait,idem,sticky}:*` are reserved by keys.ts but not populated
# in 4A — the wait-queue / idempotency / sticky features land in Plan 4B/4C.
```

BullMQ sets its own key namespace separately from ioredis's `keyPrefix`
(its Lua scripts compute keys directly). `usageLogQueue.ts` sets BullMQ's
prefix to `aide:gw` so its keys colocate with the rest — see the module
header.

### BullMQ queue stats

The usage-log queue is `aide:gw:usage-log`. Expose via any BullMQ UI
(Bull Board / Arena), or poll directly:

```sh
docker compose exec redis redis-cli --raw ZCARD aide:gw:usage-log:wait
docker compose exec redis redis-cli --raw ZCARD aide:gw:usage-log:delayed
docker compose exec redis redis-cli --raw LRANGE aide:gw:usage-log:failed 0 -1
```

Or scrape `/metrics`:

```sh
curl -s localhost:3002/metrics | grep -E 'gw_queue_(depth|dlq_count)'
```

### Database state

Common inspection queries are in [`../../docs/GATEWAY.md#8-runbook`](../../docs/GATEWAY.md#8-runbook)
— upstream account state, billing reconciliation, OAuth refresh status.

For ad-hoc dev:

```sh
docker compose exec postgres psql -U aide -d aide
# \dt — list tables
# SELECT id, name, status, priority, concurrency FROM upstream_accounts WHERE deleted_at IS NULL;
# SELECT SUM(total_cost) FROM usage_logs WHERE api_key_id = '<id>';
```

---

## Layout

```
apps/gateway/src/
  server.ts                  # buildServer(): Fastify app + lifecycle wiring
  middleware/apiKeyAuth.ts   # Bearer + x-api-key resolution, IP allowlist, authblock
  plugins/metrics.ts         # prom-client registry, gateway-scoped counters/histograms
  plugins/db.ts              # Drizzle decoration + test injection seam
  redis/client.ts            # ioredis plugin with aide:gw: prefix
  redis/slots.ts             # Lua-atomic concurrency slot acquire/release
  routes/messages.ts         # POST /v1/messages (streaming + non-streaming)
  routes/chatCompletions.ts  # POST /v1/chat/completions (non-streaming in 4A)
  runtime/                   # failover loop, OAuth refresh, upstream call, usage logging
  workers/                   # BullMQ usage-log queue + worker, billing audit, OAuth cron
```

Contracts that should not change without a plan:

- `packages/db/src/schema/*` — see schema policy in
  [`../../docs/GATEWAY.md#9-schema-change-policy`](../../docs/GATEWAY.md#9-schema-change-policy).
- `@caliber/config` env shape — any new var needs a zod-enforced default plus
  a docs entry in `docs/GATEWAY.md`.
- `/v1/messages` and `/v1/chat/completions` response shapes — must track
  Anthropic / OpenAI on the wire so SDKs keep working.

---

## CI

Two jobs in `.github/workflows/ci.yml` exercise the gateway on every PR:

- `lint-typecheck-test` — runs `pnpm turbo run lint typecheck test` across
  every package (covers the unit suite here).
- `gateway-integration` — `pnpm --filter @caliber/gateway test:integration` and
  `pnpm --filter @caliber/gateway-core test`, on ubuntu-latest with a Docker
  daemon for testcontainers.

Release images (`ghcr.io/hanfour/aide-gateway:${VERSION}`) are built by
`.github/workflows/release.yml` on every `v*` tag, multi-arch
`linux/amd64,linux/arm64`.
