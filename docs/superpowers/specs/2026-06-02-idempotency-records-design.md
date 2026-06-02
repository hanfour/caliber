# `idempotency_records` table (Plan 4A §4.5) + idempotency tenant-scoping fix — design

**Date:** 2026-06-02
**Status:** approved (brainstorming)
**Scope:** (a) a security fix to the **deployed** Redis idempotency cache (tenant-scope the key), plus (b) one migration + one schema + one write hook + one purge cron for `idempotency_records`. Both ship in one PR because they share the tenant-scope key shape. Single implementation plan.

## Prerequisite security fix — tenant-scope the Redis idempotency key

**Bug (in deployed v0.7.6, introduced by #185 / #186):** `keys.idem(requestId) = `idem:${requestId}`` is **not tenant-scoped**, and the idempotency key is the raw client `X-Request-Id` header. Within the 300 s Redis TTL, if tenant B sends an `X-Request-Id` value that tenant A already used, B receives **A's cached response body replayed** (or a `409 request_in_progress` revealing A's in-flight request). The response cache (`computeCacheKey`) correctly scopes by `orgId`; the idempotency cache does not. This is a cross-tenant data leak.

**Fix:** scope the idempotency key by **`api_key_id`** (the natural caller boundary; one api key belongs to one org). Minimal, no signature churn on the redis primitives:

- `checkIdempotency` (`runtime/idempotencyCache.ts`) gains a `scope: string` dep (the `api_key_id`). Internally it composes `cacheKey = `${scope}:${requestKey}`` and passes **that** to `getCached` / `setInFlight` (so the Redis key becomes `idem:{apiKeyId}:{X-Request-Id}`). `getCached` / `setCached` / `setInFlight` / `keys.idem` are **unchanged** — they just receive the composite string.
- The returned `idemKey` is the composite `cacheKey`, so `storeIdempotent` stores under the same scoped key automatically (no change to `storeIdempotent`).
- The `409` body keeps `requestId: requestKey` (the **raw** `X-Request-Id`) — the composite (which contains the api-key UUID) is never echoed to the client.
- `checkRequestIdempotency` (`routes/idempotencyEntry.ts`) passes `scope: req.apiKey.id` (`req.apiKey` is guaranteed by the handlers' top-of-function 401 defense check, which runs before the idempotency entry).

**Deploy note:** no Redis migration. On deploy, any old unscoped `idem:<id>` keys orphan and expire within ≤300 s; idempotency is best-effort/opt-in so the brief gap is harmless.

**Regression test:** two api keys (same or different org) send the same `X-Request-Id`; assert the second is **not** served A's cached response and gets no `409` from A's marker — each key has an independent idempotency namespace.

## Problem

Plan 4A §4.5 specifies, beyond the Redis idempotency cache:

> `idempotency_records` table (DB) also stores request metadata for 1 hour — supports billing queries and refunds.

The Redis idempotency cache (client opt-in via `X-Request-Id`, default 300 s TTL, fail-closed) is already live on every write surface. It handles **deduplication**: a replayed request returns the cached 200 with `x-idempotent-replay: true` and **writes no new `usage_logs` row**.

That last point is the gap this table fills. `usage_logs` records billing per request, but keyed on the gateway's **internal** `req.id` (one row per real upstream dispatch). A replay produces no row. So a refund/billing query phrased in terms of the **client's** `X-Request-Id` cannot resolve a request that was served as a replay. `idempotency_records` is the `X-Request-Id` → billing-snapshot map, retained 1 hour, that closes that gap.

## Non-goals

- **Not** a change to dedup *semantics* — the Redis cache's replay/conflict/fail-closed behaviour is unchanged; the prerequisite fix only tenant-scopes its key.
- **Not** a replacement for `usage_logs` — `usage_logs` remains the permanent, authoritative billing ledger.
- **Not** wired to any refund/billing UI — this PR only produces the durable record. Query/refund tooling is future work.

## Schema (`packages/db/src/schema/idempotencyRecords.ts`)

Table `idempotency_records`:

**Primary key:** composite **`(api_key_id, request_id)`** — tenant-scoped, matching the scoped Redis key. Bare `request_id` would let tenant B overwrite tenant A's billing snapshot when both use the same `X-Request-Id` after the 5 min Redis TTL but within the 1 h DB window.

| column | type | notes |
|--------|------|-------|
| `api_key_id` | `uuid NOT NULL` → `api_keys.id` **ON DELETE CASCADE** | part of the composite PK (caller scope) |
| `request_id` | `text NOT NULL` | the client `X-Request-Id`; part of the composite PK |
| `internal_request_id` | `text NOT NULL` | the gateway `req.id`; links to `usage_logs.request_id` of the original dispatch |
| `org_id` | `uuid NOT NULL` → `organizations.id` **ON DELETE CASCADE** | ephemeral 1 h table; cascade so it never blocks an admin delete (contrast `usage_logs`' `restrict`, which guards the permanent ledger) |
| `user_id` | `uuid NOT NULL` → `users.id` **ON DELETE CASCADE** | |
| `requested_model` | `text NOT NULL` | |
| `surface` | `text NOT NULL` | e.g. `messages`, `responses`, `chat-completions` |
| `platform` | `text NOT NULL` | `anthropic` \| `openai` |
| `status_code` | `integer NOT NULL` | |
| `total_cost` | `numeric(20,10) NOT NULL default '0'` | self-contained billing snapshot (raw provider cost) |
| `actual_cost_usd` | `numeric(20,10) NOT NULL default '0'` | snapshot of multiplier-applied cost (the value budgets charge against) |
| `created_at` | `timestamptz NOT NULL default now()` | time of the dispatch this row reflects; refreshed to `now()` on conflict (see Write path) |
| `expires_at` | `timestamptz NOT NULL` | `created_at + GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC` (default 1 h); purge key |

Indexes:
- `idempotency_records_expires_at_idx` on `(expires_at)` — purge scan.
- `idempotency_records_org_created_idx` on `(org_id, created_at)` — billing queries.

Decimal precision `(20,10)` matches `usage_logs.total_cost` / `actual_cost_usd` so the snapshot never loses precision relative to the ledger.

## Write path

Written inline, fire-and-forget, from `apps/gateway/src/runtime/usageLogging.ts` — the one place where the cost breakdown **and** `req` (hence the `X-Request-Id` header) are both in scope, co-located with the existing `usage_logs` enqueue.

- **Trigger:** only when `req.headers["x-request-id"]` is present **and** `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0`. Non-participating requests write nothing — zero behaviour change for the common path.
- **Source values:** `request_id` = the raw `X-Request-Id`; `api_key_id` = `payload.apiKeyId`; `internal_request_id` = `payload.requestId` (`req.id`); `org_id`/`user_id`/`requested_model`/`surface`/`platform`/`status_code` from the already-built usage-log `payload`. **Cost: write `payload.totalCost` and `payload.actualCostUsd`** — these are the canonical persisted strings (usageLogging.ts:369–370): `payload.totalCost` already includes OpenAI cached-input cost (`totalWithCachedInput`) and `payload.actualCostUsd` is multiplier-applied. The raw `cost` `CostBreakdown` excludes both, so it must NOT be used. `expires_at` = now + `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC`.
- **Conflict:** `ON CONFLICT (api_key_id, request_id) DO UPDATE` refreshing **all** non-PK columns to the new dispatch's values — `internal_request_id`, `requested_model`, `surface`, `platform`, `status_code`, `total_cost`, `actual_cost_usd`, **`created_at = now()`**, and `expires_at = now() + TTL`. A conflict only happens when the same `(api_key_id, X-Request-Id)` is reused for a genuinely *new* dispatch (after the 5-min Redis TTL, within the 1-h DB window), so the row must wholly reflect that latest dispatch — including `created_at`, or the `(org_id, created_at)` billing query would report the stale first-dispatch time. The row is "latest dispatch under this key", not "first seen".
- **Robustness:** fire-and-forget (`void insert().catch(() => {})`), never throws, never blocks the user response — mirrors `storeIdempotent`. A failed write loses one supplementary record, nothing billing-critical (`usage_logs` is unaffected).
- **Replays write nothing here either:** a replay never reaches `emitUsageLog` (no dispatch), so the original record (already present, ≤1 h old) is the single source — no double-write.

New env knob (mirrors the cache/purge knobs): `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC` (default `3600`, `0` disables the DB record entirely — the Redis dedup cache is independent and unaffected). Parsed in `@caliber/config`.

## Retention / purge

Mirror `apps/gateway/src/workers/bodyPurge.ts`:

- `purgeExpiredIdempotencyRecords({ db, now?, batchSize? })` — batched delete looping until 0 rows, `MAX_ITERATIONS` guard, returns `{ deleted, durationSec }`. Compute a single `const cutoff = now()` (the **injected** clock, default `() => new Date()`, matching `bodyPurge`) and bind it everywhere — so test overrides and production share one cutoff. Two correctness requirements:
  - **Composite delete target, not bare `request_id`** — with `(api_key_id, request_id)` two callers can share a `request_id`, so `WHERE request_id IN (…)` would wrongly remove another key's row.
  - **Re-check `expires_at <= cutoff` in the outer `WHERE`** — between the subquery selecting a doomed `(api_key_id, request_id)` and the delete, a concurrent new dispatch may `ON CONFLICT`-refresh that exact key into a *fresh* row (new `expires_at`). Matching on PK alone would delete the just-refreshed row, contradicting "row = latest dispatch". The outer recheck (same `cutoff`) skips any row refreshed past the cutoff.

  ```sql
  DELETE FROM idempotency_records r
  USING (
    SELECT api_key_id, request_id FROM idempotency_records
    WHERE expires_at <= ${cutoff} LIMIT ${batchSize}
  ) doomed
  WHERE r.api_key_id = doomed.api_key_id
    AND r.request_id = doomed.request_id
    AND r.expires_at <= ${cutoff}
  ```
- `startIdempotencyPurgeCron(...)` scheduled via `setInterval` in `server.ts` (interval-based scheduling is the repo convention; no cron-expression parser). `IDEMPOTENCY_PURGE_INTERVAL_MS` = 1 h (sufficient for a 1-h-TTL table).
- **Gating (finding 3):** the body-purge cron is wrapped in `if (opts.env.ENABLE_EVALUATOR)` (server.ts:181) because captured bodies only exist when the evaluator is on. `idempotency_records` are **gateway** data, written whenever idempotency is active **regardless of the evaluator**. So the new purge cron must be gated on **`opts.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0`** (the same knob that enables the write), NOT on `ENABLE_EVALUATOR` — otherwise with the evaluator off, records would accumulate unpurged forever. It stays inside the existing `opts.redis === undefined` test-mode gate (tests call the purge fn directly).
- **Metric:** `gw_idempotency_records_purged_total` Counter (no labels), defined in `metrics.ts` (def + zero-init `inc(0)` + decorate), incremented by the cron with the deleted count — consistent with `gw_body_purge_deleted_total`.

## Migration (`0017`)

**Generate via `pnpm drizzle-kit generate` — do NOT hand-author the journal entry.** This is the explicit mitigation for the recurring journal-`when` hazard (the 0015/0016 saga): drizzle-kit stamps the new journal entry's `when` with `Date.now()` at generation time (today ≈ 1.78e12+), which is **strictly greater** than prod's current max `__drizzle_migrations.created_at` (the manual 0016 insert at `1779873493734`). A hand-set past `when` could be shadowed by a late-applied prior migration's real-time `created_at` and silently skipped. Verify after generation that `0017`'s journal `when` > `1779873493734`.

The migration only `CREATE TABLE` + indexes — no data backfill, no column drops, no destructive change. A `0017_down.sql` drops the table.

## Testing

- **Tenant-scope (security regression):** two api keys send the same `X-Request-Id`; assert key B is not served key A's cached response and gets no `409` from A's in-flight marker (independent namespaces). Assert the scoped Redis key shape `idem:{apiKeyId}:{X-Request-Id}` and that the `409` body still reports the raw `X-Request-Id`. Existing idempotency unit/integration tests updated for the new `scope` dep.
- **Schema/migration:** integration test applies `0017` in a testcontainer (CI `gateway-integration` / `integration` already do migration application).
- **Write path:** unit/integration test of the write hook — with `X-Request-Id` present → row inserted with `api_key_id` + raw `request_id`, snapshot using `payload.totalCost`/`payload.actualCostUsd`, `expires_at ≈ now + TTL`; without the header → no row; with `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC=0` → no row; conflict (same `(api_key_id, request_id)` twice) → single row, refreshed; **different api keys, same `request_id` → two distinct rows**. Assert it never throws on a failing `db`.
- **Purge:** unit test of `purgeExpiredIdempotencyRecords` — seeds expired + fresh rows, asserts only expired deleted, batches correctly, returns count; metric incremented. Plus the round-2/3 load-bearing details:
  - **Composite-key regression:** key A has expired `request_id=x`, key B has fresh `request_id=x` → only A's row deleted, B survives.
  - **Injected-cutoff boundary:** with injected `now() = T`, a row at `expires_at = T` is deleted and one at `expires_at = T + 1s` survives; re-run with a different `T` to prove the *injected* clock (not DB `now()`) drives the delete. This locks that the same `cutoff` is bound into the effective delete filter.
  - **Concurrent-refresh recheck:** integration test (real Postgres, two connections) — mark `(A,x)` expired, begin the purge, and from a second connection `ON CONFLICT`-refresh `(A,x)` to a fresh `expires_at` before the delete commits; assert the refreshed row survives (the outer `r.expires_at <= cutoff` recheck skips it). If the harness can't interleave reliably, fall back to asserting the generated statement contains the outer `expires_at <= cutoff` recheck bound to the same cutoff as the subquery.
  - Assert the cron is gated on the TTL knob, not `ENABLE_EVALUATOR`.
- Coverage ≥ 80 %.

## Out of scope (explicitly deferred)

- Refund/billing query tooling or UI that consumes the table.
- Any change to the Redis idempotency cache or dedup behaviour **beyond tenant-scoping the key** (the prerequisite fix above) — the replay/conflict/fail-closed semantics are unchanged.
- Backfill (the table starts empty; only future X-Request-Id requests populate it).
