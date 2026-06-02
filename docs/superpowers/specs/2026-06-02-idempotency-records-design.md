# `idempotency_records` table (Plan 4A §4.5) — design

**Date:** 2026-06-02
**Status:** approved (brainstorming)
**Scope:** one migration + one schema + one write hook + one purge cron. Single implementation plan.

## Problem

Plan 4A §4.5 specifies, beyond the Redis idempotency cache:

> `idempotency_records` table (DB) also stores request metadata for 1 hour — supports billing queries and refunds.

The Redis idempotency cache (client opt-in via `X-Request-Id`, default 300 s TTL, fail-closed) is already live on every write surface. It handles **deduplication**: a replayed request returns the cached 200 with `x-idempotent-replay: true` and **writes no new `usage_logs` row**.

That last point is the gap this table fills. `usage_logs` records billing per request, but keyed on the gateway's **internal** `req.id` (one row per real upstream dispatch). A replay produces no row. So a refund/billing query phrased in terms of the **client's** `X-Request-Id` cannot resolve a request that was served as a replay. `idempotency_records` is the `X-Request-Id` → billing-snapshot map, retained 1 hour, that closes that gap.

## Non-goals

- **Not** the dedup mechanism — that is the Redis cache, unchanged.
- **Not** a replacement for `usage_logs` — `usage_logs` remains the permanent, authoritative billing ledger.
- **Not** wired to any refund/billing UI — this PR only produces the durable record. Query/refund tooling is future work.

## Schema (`packages/db/src/schema/idempotencyRecords.ts`)

Table `idempotency_records`:

| column | type | notes |
|--------|------|-------|
| `request_id` | `text` **PRIMARY KEY** | the client `X-Request-Id` (the idempotency key); one record per client request id |
| `internal_request_id` | `text NOT NULL` | the gateway `req.id`; links to `usage_logs.request_id` of the original dispatch |
| `org_id` | `uuid NOT NULL` → `organizations.id` **ON DELETE CASCADE** | ephemeral 1 h table; cascade so it never blocks an admin delete (contrast `usage_logs`' `restrict`, which guards the permanent ledger) |
| `user_id` | `uuid NOT NULL` → `users.id` **ON DELETE CASCADE** | |
| `api_key_id` | `uuid NOT NULL` → `api_keys.id` **ON DELETE CASCADE** | |
| `requested_model` | `text NOT NULL` | |
| `surface` | `text NOT NULL` | e.g. `messages`, `responses`, `chat-completions` |
| `platform` | `text NOT NULL` | `anthropic` \| `openai` |
| `status_code` | `integer NOT NULL` | |
| `total_cost` | `numeric(20,10) NOT NULL default '0'` | self-contained billing snapshot (raw provider cost) |
| `actual_cost_usd` | `numeric(20,10) NOT NULL default '0'` | snapshot of multiplier-applied cost (the value budgets charge against) |
| `created_at` | `timestamptz NOT NULL default now()` | |
| `expires_at` | `timestamptz NOT NULL` | `created_at + 1 hour`; purge key |

Indexes:
- `idempotency_records_expires_at_idx` on `(expires_at)` — purge scan.
- `idempotency_records_org_created_idx` on `(org_id, created_at)` — billing queries.

Decimal precision `(20,10)` matches `usage_logs.total_cost` / `actual_cost_usd` so the snapshot never loses precision relative to the ledger.

## Write path

Written inline, fire-and-forget, from `apps/gateway/src/runtime/usageLogging.ts` — the one place where the cost breakdown **and** `req` (hence the `X-Request-Id` header) are both in scope, co-located with the existing `usage_logs` enqueue.

- **Trigger:** only when `req.headers["x-request-id"]` is present (idempotency-participating requests). Non-participating requests write nothing — zero behaviour change for the common path.
- **Source values:** `request_id` = the `X-Request-Id`; `internal_request_id` = `payload.requestId` (`req.id`); `org_id`/`user_id`/`api_key_id`/`requested_model`/`surface`/`platform`/`status_code` from the already-built usage-log payload; `total_cost`/`actual_cost_usd` from the computed `cost` breakdown; `expires_at` = now + 1 h.
- **Conflict:** `ON CONFLICT (request_id) DO UPDATE` (refresh the snapshot + `expires_at`). Handles the rare case where the same `X-Request-Id` is reused for a genuinely new dispatch after the 5-min Redis TTL but within the 1-h DB window.
- **Robustness:** fire-and-forget (`void insert().catch(() => {})`), never throws, never blocks the user response — mirrors `storeIdempotent`. A failed write loses one supplementary record, nothing billing-critical (`usage_logs` is unaffected).
- **Replays write nothing here either:** a replay never reaches `emitUsageLog` (no dispatch), so the original record (already present, ≤1 h old) is the single source — no double-write.

New env knob (mirrors the cache/purge knobs): `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC` (default `3600`, `0` disables the DB record entirely — the Redis dedup cache is independent and unaffected). Parsed in `@caliber/config`.

## Retention / purge

Mirror `apps/gateway/src/workers/bodyPurge.ts`:

- `purgeExpiredIdempotencyRecords({ db, now?, batchSize? })` — batched `DELETE FROM idempotency_records WHERE request_id IN (SELECT … WHERE expires_at <= now() LIMIT batchSize)`, looping until 0 rows, `MAX_ITERATIONS` guard. Returns `{ deleted, durationSec }`.
- `startIdempotencyPurgeCron(...)` scheduled via `setInterval` in `server.ts` alongside the body-purge cron (interval-based scheduling is the repo convention; no cron-expression parser). Interval: reuse the existing purge cadence constant style — `IDEMPOTENCY_PURGE_INTERVAL_MS` (1 h is sufficient for a 1-h-TTL table; pick 1 h).
- **Metric:** `gw_idempotency_records_purged_total` Counter (no labels), defined in `metrics.ts` (def + zero-init `inc(0)` + decorate), incremented by the cron with the deleted count — consistent with `gw_body_purge_deleted_total`.

## Migration (`0017`)

**Generate via `pnpm drizzle-kit generate` — do NOT hand-author the journal entry.** This is the explicit mitigation for the recurring journal-`when` hazard (the 0015/0016 saga): drizzle-kit stamps the new journal entry's `when` with `Date.now()` at generation time (today ≈ 1.78e12+), which is **strictly greater** than prod's current max `__drizzle_migrations.created_at` (the manual 0016 insert at `1779873493734`). A hand-set past `when` could be shadowed by a late-applied prior migration's real-time `created_at` and silently skipped. Verify after generation that `0017`'s journal `when` > `1779873493734`.

The migration only `CREATE TABLE` + indexes — no data backfill, no column drops, no destructive change. A `0017_down.sql` drops the table.

## Testing

- **Schema/migration:** integration test applies `0017` in a testcontainer (CI `gateway-integration` / `integration` already do migration application).
- **Write path:** unit/integration test of the write hook — with `X-Request-Id` present → row inserted with the expected snapshot + `expires_at ≈ now+1h`; without the header → no row; conflict (same id twice) → single row, refreshed. Assert it never throws on a failing `db`.
- **Purge:** unit test of `purgeExpiredIdempotencyRecords` — seeds expired + fresh rows, asserts only expired deleted, batches correctly, returns count; metric incremented.
- Coverage ≥ 80 %.

## Out of scope (explicitly deferred)

- Refund/billing query tooling or UI that consumes the table.
- Any change to the Redis idempotency cache or the dedup behaviour.
- Backfill (the table starts empty; only future X-Request-Id requests populate it).
