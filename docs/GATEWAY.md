# Gateway

The **Caliber gateway** is an opt-in data plane that lets your users (and their
tools — Claude Code, Cursor, OpenAI-compatible clients, etc.) call Anthropic
through a shared pool of upstream accounts managed by an organisation.

This guide covers the operator-facing pieces (accounts, API keys, runbook,
schema policy) and the end-user-facing pieces (client examples). For the infra
bring-up see [`SELF_HOSTING.md`](./SELF_HOSTING.md); for local development see
[`../apps/gateway/README.md`](../apps/gateway/README.md).

> Status: ships in **v0.3.0** as Plan 4A. Opt-in behind `ENABLE_GATEWAY=true` +
> the `gateway` docker-compose profile. Anthropic is the only supported
> upstream platform in 4A.

---

## 1. Architecture overview

```
  apps/web  (Next.js, :3000)
      │    rewrites /trpc/* → apps/api
      ▼
  apps/api  (Fastify, :3001)            apps/gateway  (Fastify, :3002)
      ├─ tRPC admin plane                   ├─ POST /v1/messages
      ├─ accounts / apiKeys / usage         ├─ POST /v1/chat/completions
      ├─ session-cookie auth                ├─ GET  /health
      │                                     ├─ GET  /metrics
      ▼                                     ▼
   Postgres (shared)  ◄── @caliber/db ────► Postgres (shared)
        ▲                                    ▲
        └──────── Redis ─────────────────────┘   ─► Anthropic upstream
                 (slots, queue, idempotency,
                  sticky, OAuth refresh lock)
```

**Separation of concerns.** The gateway is strictly a data plane: it speaks
HTTP to Anthropic on behalf of one of several **upstream accounts** owned by
the org, and it authenticates inbound calls with **platform-issued API keys**
(`ak_...`). It has no session cookies, no tRPC, no admin UI. All CRUD for
accounts and keys happens on `apps/api` via tRPC, behind the existing RBAC +
session cookie auth.

**Workspace packages.**

| Package | Role |
|---|---|
| `apps/gateway` | Fastify server, request pipeline, workers, Redis plumbing |
| `packages/gateway-core` | Shared logic — translation, pricing, state machine, DB helpers — consumed by both `apps/gateway` (runtime) and `apps/api` (admin CRUD) |
| `@caliber/config` | `parseServerEnv` + `ServerEnv` type. All gateway vars live here. |
| `@caliber/db` | Schema, migrations, Drizzle client. Gateway adds `upstream_accounts`, `credential_vault`, `api_keys`, `usage_logs` (see migration `0005_gateway_schema.sql`). |
| `@caliber/auth` | RBAC. Gateway adds `account.*`, `api_key.*`, `usage.*` action families. |

**Endpoints shipped in 4A.**

| Verb + path | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic-native — streaming and non-streaming |
| `POST /v1/chat/completions` | OpenAI-compatible — non-streaming only in 4A (streaming returns `501`; translator lands post-4A) |
| `GET /health` | `{"status":"ok"}` when `ENABLE_GATEWAY=true`; `{"status":"disabled"}` otherwise. Never 5xx by design — liveness probes stay green even when the route surface is off. |
| `GET /metrics` | Prometheus scrape endpoint (see [§7 Observability](#7-observability)). |

**RBAC actions added.**

| Action | Minimum role | Notes |
|---|---|---|
| `account.read` / `account.create` / `account.update` / `account.delete` / `account.rotate` | `team_manager` (org-scope) / `super_admin` (platform) | `update` / `rotate` are stubbed "Soon" UI in 4A; tRPC endpoints exist. |
| `api_key.list_own` / `api_key.issue_own` | any authenticated org member | Self-service in `/dashboard/profile`. |
| `api_key.list_all` / `api_key.issue_for_user` | `team_manager` (org-scope) | Admin + one-time URL flow; see [§4](#4-api-key-distribution). |
| `api_key.revoke` | key owner, or `api_key.issue_for_user` holder | Revocation sets `revoked_at`; gateway rejects on next request. |
| `usage.read_own` | any authenticated user | Self usage in `/dashboard/profile/usage`. |
| `usage.read_user` / `usage.read_team` | `team_manager` within the target team / org | Used by the org usage dashboards' drill-downs. |
| `usage.read_org` | `team_manager` + (org-scope) | Org-wide usage dashboards. |

---

## 2. Configuration

All env vars are validated by `parseServerEnv` (`packages/config/src/env.ts`)
at boot. Bad shape throws with the offending field(s) listed; the gateway's
top-level bootstrap logs the error and `process.exit(1)` on the unhandled
rejection, so a misconfigured container never accepts traffic.

| Env | Required when | Default | Purpose |
|---|---|---|---|
| `ENABLE_GATEWAY` | always | `false` | Feature flag. When `false`, only `/health` is served. |
| `GATEWAY_PORT` | always | `3002` | Listen port. |
| `GATEWAY_BASE_URL` | `ENABLE_GATEWAY=true` | — | Public URL users point their SDK at. Shown in the reveal page. |
| `REDIS_URL` | `ENABLE_GATEWAY=true` | — | Redis 7+. Required — no in-memory fallback. |
| `CREDENTIAL_ENCRYPTION_KEY` | `ENABLE_GATEWAY=true` | — | 32 bytes (64 hex chars). AES-256-GCM master for `credential_vault`. **Inject via secret mount, never commit.** |
| `API_KEY_HASH_PEPPER` | `ENABLE_GATEWAY=true` | — | 32 bytes (64 hex chars). HMAC-SHA256 pepper for `api_keys.key_hash`. **Inject via secret mount, never commit.** Losing it invalidates every key by design. |
| `UPSTREAM_ANTHROPIC_BASE_URL` |  | `https://api.anthropic.com` | Override for staging / fake upstream in tests. |
| `GATEWAY_MAX_ACCOUNT_SWITCHES` |  | `10` | Failover cap per request. |
| `GATEWAY_MAX_BODY_BYTES` |  | `10485760` | Request body limit (10 MiB). |
| `GATEWAY_BUFFER_WINDOW_MS` |  | `500` | Smart-buffer time limit before committing the response. |
| `GATEWAY_BUFFER_WINDOW_BYTES` |  | `2048` | Smart-buffer byte limit. |
| `GATEWAY_REDIS_FAILURE_MODE` |  | `strict` | `strict`: fail-closed on Redis loss. `lenient`: accept traffic without concurrency / idempotency / sticky. |
| `GATEWAY_IDEMPOTENCY_TTL_SEC` |  | `300` | Cache TTL for `X-Request-Id` replay. |
| `GATEWAY_TRUSTED_PROXIES` |  | `""` | CIDR list allowed to set `X-Forwarded-For`. Empty = trust socket only. |
| `GATEWAY_OAUTH_REFRESH_LEAD_MIN` |  | `10` | Minutes before expiry at which inline refresh fires. |
| `GATEWAY_OAUTH_MAX_FAIL` |  | `3` | Refresh failures before the account is parked with `status='error'`. |
| `GATEWAY_QUEUE_SATURATE_THRESHOLD` |  | `5000` | BullMQ `wait+active` count above which strict mode rejects new billing-incurring requests. |
| `GATEWAY_APIKEY_RPM_LIMIT` |  | `600` | Per-apiKey requests-per-minute cap (fixed-bucket sliding window). 0 disables enforcement. Sets `x-ratelimit-{limit,remaining}` headers on every response; over-limit returns 429 + `Retry-After`. |
| `GATEWAY_CACHE_TTL_SEC` |  | `0` | Response cache TTL for non-streaming /v1/* endpoints. **0 = OFF (default)**. When >0, identical `(orgId, endpoint, body)` tuples within the TTL window short-circuit upstream. Cached payloads contain model output (not prompts); confirm data classification permits it before enabling. Sets `x-cache: hit\|miss` headers when enabled. |
| `UPSTREAM_ANTHROPIC_BASE_URL` |  | `https://api.anthropic.com` | Override for staging / fake upstream in tests. |
| `UPSTREAM_OPENAI_BASE_URL` |  | `https://api.openai.com` | Override for staging / fake upstream in tests. |

**Secrets posture.** `CREDENTIAL_ENCRYPTION_KEY` and `API_KEY_HASH_PEPPER`
should never appear in `.env` checked into a repo, logs, or stack traces.
Prefer Docker secrets, Kubernetes secrets, or your cloud's equivalent. The
compose file in `docker/docker-compose.yml` uses soft defaults (`${VAR:-}`) so
the **base** profile boots without these; the container itself fails fast if
the `gateway` profile is started without them.

---

## 3. Upstream account management

An **upstream account** is one credential that the gateway may use to talk to
Anthropic. An org typically has several: personal API keys donated by
engineers, OAuth accounts extracted from Claude Code installs, shared team
keys, etc. The gateway picks one per request via a scheduler that considers
priority, per-account concurrency, rate-limit state, and team scope.

**Admin UI.**

| Page | RBAC |
|---|---|
| `/dashboard/organizations/[id]/accounts` | `account.read` |
| `/dashboard/organizations/[id]/accounts/new` | `account.create` |
| `/dashboard/organizations/[id]/teams/[tid]` → Accounts tab | `account.read` |
| `/dashboard/organizations/[id]/account-groups` | `account_group.read` |
| `/dashboard/organizations/[id]/account-groups/new` | `account_group.create` |
| `/dashboard/organizations/[id]/account-groups/[gid]` | `account_group.read` (members CRUD requires `account_group.manage_members`) |

**Account groups.** Groups bundle multiple upstream accounts of the same
platform under a single name + rate multiplier; the gateway scheduler
load-balances across members by ascending `priority`. The admin UI
covers full CRUD: create / rename / disable / soft-delete groups, and
add / remove / reprioritise members. The Phase 1 OpenAI onboarding
story is most useful with groups — admins typically create one group
per platform/environment (e.g. `openai-prod-pool`) and pin several
project-scoped `sk-` keys with different priorities + spend caps.

**Shape stored per account** (see `packages/db/src/schema/accounts.ts`):

- `name`, `notes`, `platform` (`anthropic` or `openai`), `type`
  (`api_key` or `oauth` — OAuth path is Anthropic-only in the admin UI)
- `org_id` (required), `team_id` (null = org-scoped, set = team override)
- Scheduling: `priority` (lower = preferred), `concurrency` (per-account
  parallelism, default 3), `rate_multiplier`
- State: `rate_limited_at`, `rate_limit_reset_at`, `overload_until`,
  `temp_unschedulable_until`, `status` (`active` | `error` | `disabled`)
- OAuth tracking: `oauth_refresh_fail_count`, `oauth_refresh_last_error`,
  `oauth_refresh_last_run_at`
- Lifecycle: `expires_at`, `auto_pause_on_expired`, `deleted_at` (soft delete)

**Credentials** live in a separate `credential_vault` table and are encrypted
with AES-256-GCM, sub-key derived via HKDF-SHA256 from
`CREDENTIAL_ENCRYPTION_KEY` with `salt=account_id` and `info="caliber-gateway-credential-v2"`.
The gateway decrypts on each failover attempt (cache: none in 4A).

**Adding an account.**

1. Open `/dashboard/organizations/[id]/accounts/new`
2. Pick scope (org-wide or team override), platform (`anthropic` or
   `openai`), type
3. Paste credentials:
   - `anthropic` + `type=api_key` → `sk-ant-...`
   - `anthropic` + `type=oauth` → JSON `{ "access_token", "refresh_token", "expires_at" }`
     (extract from your own Claude Code install)
   - `openai` + `type=api_key` → `sk-...` / `sk-proj-...` from a
     compliant OpenAI org / project. See
     [`admin/openai-account-setup.md`](./admin/openai-account-setup.md)
     for the step-by-step including spend caps, key scoping, and
     rotation.  The form intentionally hides `oauth` for OpenAI.
4. Submit. Backend inserts `credential_vault` + `upstream_accounts` in one
   transaction. Credentials never appear in logs.

**Rotating / editing.** The tRPC `accounts.update` and `accounts.rotate`
mutations exist, but the UI renders them as "Soon" disabled actions in 4A —
for now rotate by soft-deleting and creating a new account. Full rotate/edit
forms land in Plan 4B.

**Soft delete.** `accounts.delete` sets `deleted_at` and `status='disabled'`.
The scheduler skips soft-deleted rows immediately. Restore by clearing
`deleted_at` via SQL; a formal undelete mutation isn't in 4A scope.

---

## 4. API key distribution

Platform-issued keys (`ak_...`, 64 chars total) are what your users paste
into their SDK.
They are **hashed** before storage — `key_hash =
HMAC-SHA256(API_KEY_HASH_PEPPER, raw_key)` — and the raw string is shown
exactly once. Two issuance flows are supported.

### 4.1 Self-service

Page: **`/dashboard/profile`** → "API Keys" section. RBAC:
`api_key.issue_own` (every authenticated member).

1. Click **Create new key**
2. Dialog: name, optional IP whitelist (CIDR), optional quota (USD), optional
   `expires_at`
3. Submit → backend inserts `api_keys` row, returns the raw key in the
   response **once**
4. UI shows the reveal panel with a copy button and a warning — closing it
   loses the key permanently
5. Afterwards the key appears in the list with only its prefix (first 8
   chars) and can be revoked

### 4.2 Admin-issued (one-time URL)

Page: **`/dashboard/organizations/[id]/members/[uid]`** → the member's API
keys tab. RBAC: `api_key.issue_for_user` (minimum `team_manager`).

Why not "admin sees the key then hands it over": the admin never sees the
plaintext. This reduces leak surface via screenshots / screen shares, gives
the target user definitive custody on first open, and produces an auditable
`revealed_at` + `revealed_by_ip` trail.

Flow:

1. Admin submits the issue form (name, optional IP whitelist / quota /
   expires_at, target user)
2. Backend creates `api_keys` row with `key_hash` + generates a one-time
   reveal token (32 random bytes) stored in Redis under
   `caliber:gw:key-reveal:<token>` with `EXPIRE 86400`
3. Response returns the reveal URL: `${GATEWAY_BASE_URL}/api-keys/reveal/<token>`
   — admin copies it
4. Admin delivers the URL out-of-band (Slack DM, email, in person)
5. Target user opens the URL → reveal page fetches the raw key via
   `apiKeys.revealViaToken`, renders it once with a copy button
6. On successful reveal the Redis token is `DEL`'d and the DB row gets
   `revealed_at = now()`
7. URL is single-use. Second open sees "already revealed". If unopened
   within 24 h the token expires and the admin must re-issue.

### 4.3 Authentication + IP allowlist

At request time the gateway (`apps/gateway/src/middleware/apiKeyAuth.ts`):

1. Reads `Authorization: Bearer <key>` or `x-api-key: <key>` from the request
2. Computes `HMAC-SHA256(API_KEY_HASH_PEPPER, raw)` and looks up
   `api_keys.key_hash` (O(1), unique index)
3. Rejects with `401 invalid_api_key` on miss, `401 revoked` if `revoked_at`
   is set, `401 expired` past `expires_at`
4. Enforces `ip_whitelist` / `ip_blacklist` (CIDR via `ipaddr.js`). Client
   IP comes from the socket unless the source is listed in
   `GATEWAY_TRUSTED_PROXIES`, in which case `X-Forwarded-For` is honoured.

Per-IP auth-failure brute-force throttling (design §6.7) is planned but not
wired in 4A — put a request-rate limit in your reverse proxy if you need it
now.

### 4.4 Revocation

`api_keys.revoke` mutation — self-service for your own keys, or for a key you
issued via `api_key.issue_for_user`. The gateway does **not** cache auth, so
revocation takes effect on the next request. A revoked key stays in the
table for audit and usage-log FK integrity.

---

## 5. Client examples

Publish `GATEWAY_BASE_URL` to your users. Everything below assumes
`https://gateway.example.com` — swap to your host.

### 5.1 Anthropic-native (recommended)

**curl**

```sh
curl -X POST https://gateway.example.com/v1/messages \
  -H "x-api-key: ak_REPLACE_ME" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

**Anthropic SDK (TypeScript)**

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "ak_REPLACE_ME",
  baseURL: "https://gateway.example.com",
});

const msg = await client.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
});
```

**Claude Code CLI** (treats this gateway as a vanilla Anthropic endpoint)

```sh
export ANTHROPIC_BASE_URL=https://gateway.example.com
export ANTHROPIC_API_KEY=ak_REPLACE_ME
claude
```

**Streaming.** `POST /v1/messages` supports SSE when the request body has
`"stream": true`. The gateway buffers the first ~500 ms / ~2 KB of the
upstream stream (see `GATEWAY_BUFFER_WINDOW_MS` / `GATEWAY_BUFFER_WINDOW_BYTES`)
so that a mid-connect upstream error can still be surfaced as a clean 5xx
rather than a half-empty stream. After the window closes, bytes are
forwarded verbatim.

### 5.2 OpenAI-compatible

**OpenAI SDK (TypeScript)**

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "ak_REPLACE_ME",
  baseURL: "https://gateway.example.com/v1",
});

const completion = await client.chat.completions.create({
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "hello" }],
});
```

**Streaming is not yet supported** on `/v1/chat/completions` — a request with
`stream: true` returns `501 not_implemented`. The Anthropic-to-OpenAI SSE
translator lands post-4A. Use `/v1/messages` directly if streaming matters.

### 5.3 Per-request hints (optional)

| Header | Effect |
|---|---|
| `X-Forwarded-For` | Only trusted when the socket source is in `GATEWAY_TRUSTED_PROXIES`. |

Idempotent-replay on `X-Request-Id` is planned for Plan 4B/4C. In 4A the
gateway reads `GATEWAY_IDEMPOTENCY_TTL_SEC` only to validate its shape —
neither route handler consults the cache, so the `gw_idempotency_hit_total`
counter stays at zero.

---

## 6. Usage + billing

Every request writes one `usage_logs` row asynchronously via a BullMQ queue
(`caliber:gw:queue:usage-log`). The queue writer batches into Postgres on a
small timer. If the enqueue itself fails (Redis loss), the gateway falls
through to an inline single-row insert so no request ever billed-but-unlogged
in strict mode.

**Where to look.**

| Question | Answer |
|---|---|
| Total USD spent by an org in the last 7d | `/dashboard/organizations/[id]/usage` (tRPC `usage.summaryByOrg`) |
| Per-user spend / token mix | `/dashboard/organizations/[id]/usage` → Top spenders table |
| A specific user's own usage | `/dashboard/profile/usage` (tRPC `usage.summaryForSelf`) |
| Raw per-request rows | SQL against `usage_logs` — not surfaced as a tRPC endpoint in 4A (Plan 4B evaluator will use this) |

**Quota tracking.** Each completed request increments
`api_keys.quota_used_usd` atomically alongside the `usage_logs` insert (see
`apps/gateway/src/workers/writeUsageLogBatch.ts`). Pre-flight quota
**enforcement** — rejecting with `402 quota_exceeded` before calling
upstream — is planned for Plan 4B/4C. In 4A the `quota_usd` column is for
reporting and dashboards only; if you need to cap a specific key right now,
revoke it via `apiKeys.revoke` and re-issue with a smaller scope.

**Pricing lookup.** Model prices come from a bundled
`packages/gateway-core/pricing/litellm.json` snapshot, refreshed by a weekly
GitHub Action. Unknown models produce `total_cost = 0` and bump
`gw_pricing_miss_total` rather than failing the request.

---

## 7. Observability

### `GET /health`

- `ENABLE_GATEWAY=true`  → `200 {"status":"ok"}`
- `ENABLE_GATEWAY=false` → `200 {"status":"disabled"}`

Never 5xx. Use this as your liveness / readiness probe.

### `GET /metrics`

Prometheus exposition format. Key series:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `gw_slot_acquire_total` | counter | `scope`, `result` | Concurrency slot acquisition outcomes |
| `gw_slot_hold_duration_seconds` | histogram | — | How long a request held a slot |
| `gw_wait_queue_depth` | gauge | — | (stub in 4A — populated when admission control lands) |
| `gw_idempotency_hit_total` | counter | — | (stub in 4A — populated when idempotent-replay lands) |
| `gw_sticky_hit_total` | counter | — | (stub in 4A — populated when sticky-session routing lands) |
| `gw_redis_latency_seconds` | histogram | — | Round-trip latency on gateway-owned Redis ops |
| `gw_upstream_duration_seconds` | histogram | — | Time spent in Anthropic upstream |
| `gw_pricing_miss_total` | counter | `model` | Model missing from the bundled pricing table |
| `gw_oauth_refresh_dead_total` | counter | `account_id` | Accounts that hit `GATEWAY_OAUTH_MAX_FAIL` and were parked |
| `gw_queue_depth` | gauge | — | BullMQ `wait + active` count for the usage-log queue |
| `gw_queue_dlq_count` | gauge | — | BullMQ failed-job count |
| `gw_usage_persist_lost_total` | counter | — | Rows that fell through every persistence path — should stay 0 |
| `gw_billing_drift_total` | counter | — | Keys where `|quota_used_usd − SUM(usage_logs.total_cost)| > 0.01 USD` detected by the hourly audit |
| `gw_billing_monotonicity_violation_total` | counter | — | Keys where `quota_used_usd` exceeds summed usage by more than 1¢ |

### Logs

Pino JSON on stdout. `LOG_LEVEL` controls verbosity. Request logs include
`apiKeyId`, `accountId` (selected upstream), `requestId`, `model`, and
outcome. Credentials and raw API keys are never logged.

### Billing audit

`BillingAudit` runs hourly, Bernoulli-samples ~1% of `api_keys`, and
compares `quota_used_usd` against `SUM(usage_logs.total_cost)`. Drift >
$0.01 bumps the drift counter and logs the offending `apiKeyId`.
Monotonicity violations (quota charged for rows that don't exist) bump a
separate counter.

---

## 8. Runbook

Mirrors design Section 8.3 (7 common scenarios for self-host admins).

### 1. Gateway returns `503 service_degraded`

**Most likely cause:** Redis is unreachable or timing out, and
`GATEWAY_REDIS_FAILURE_MODE=strict` is rejecting traffic.

Check:

```sh
docker compose exec redis redis-cli ping
docker compose logs --tail=200 gateway | grep -i redis
```

Fix:
- Restore Redis (restart the service, fix networking, attach a replacement
  volume, etc.).
- If Redis is expected to be degraded for a while, temporarily set
  `GATEWAY_REDIS_FAILURE_MODE=lenient` and restart the gateway. **This
  disables concurrency slots + idempotency + sticky** — accept the trade-off
  explicitly.

### 2. All requests return `all_upstreams_failed`

Every upstream account in scope was tried (up to `GATEWAY_MAX_ACCOUNT_SWITCHES`)
and none succeeded.

Check:

```sql
SELECT id, name, status, error_message,
       rate_limited_at, rate_limit_reset_at, overload_until,
       oauth_refresh_fail_count, oauth_refresh_last_error
FROM upstream_accounts
WHERE org_id = '<org-uuid>' AND deleted_at IS NULL
ORDER BY priority;
```

- If every row has a future `rate_limit_reset_at` → Anthropic rate-limited
  the pool (or there's an Anthropic outage). Check
  <https://status.anthropic.com>. Wait, or add more capacity via a new
  account.
- If rows show `status='error'` → inspect `error_message`. Common:
  credential decrypt failure (key rotation bug — see Scenario 6), OAuth
  refresh exhaustion (Scenario 3).

### 3. OAuth refresh failing repeatedly

```sql
SELECT id, name, oauth_refresh_fail_count, oauth_refresh_last_error,
       oauth_refresh_last_run_at
FROM upstream_accounts
WHERE type = 'oauth' AND oauth_refresh_fail_count > 0;
```

After `GATEWAY_OAUTH_MAX_FAIL` consecutive failures the account is parked
(`status='error'`, `schedulable=false`) and `gw_oauth_refresh_dead_total`
increments.

Common causes:
- **`refresh_token` invalidated upstream** — user revoked access in their
  Anthropic console, or the OAuth app itself was rotated. Fix by
  soft-deleting the account and adding a freshly extracted one.
- **Outbound network blocked** — firewall / egress policy dropped the
  token endpoint. Verify `curl -I https://auth.anthropic.com` (or whatever
  upstream endpoint you configured) from the gateway container.

### 4. Billing drift alert (`gw_billing_drift_total` > 0)

Manual reconcile. Pull the offending `apiKeyId` from the log line that
accompanies the counter bump, then:

```sql
-- Compare the two sides
SELECT
  ak.id,
  ak.quota_used_usd                         AS quota_side,
  COALESCE(SUM(ul.total_cost), 0)           AS usage_side,
  ak.quota_used_usd - COALESCE(SUM(ul.total_cost), 0) AS drift
FROM api_keys ak
LEFT JOIN usage_logs ul ON ul.api_key_id = ak.id
WHERE ak.id = '<apiKeyId>'
GROUP BY ak.id;
```

`usage_logs` is the authoritative source (append-only, one row per request).
If drift is real, correct `quota_used_usd` from the summed total and file
an incident — the monotonicity counter will tell you whether rows were lost
versus double-counted.

### 5. Gateway latency high

Look at two histograms:

- `gw_redis_latency_seconds` p95 > 10 ms → Redis bottleneck. Check
  `redis-cli --latency`, `INFO commandstats`, and connection count. Scale
  Redis vertically or investigate slow commands.
- `gw_upstream_duration_seconds` p95 high → Anthropic is slow, or one
  upstream account is degraded. Check <https://status.anthropic.com> and
  consider parking the slow account (`accounts.update` with
  `schedulable=false`) while you investigate.

If both are fine, check process-level metrics (event loop lag, GC) via
pino logs at `debug` level.

### 6. Every API key auth suddenly fails after a deploy

**Almost always** `API_KEY_HASH_PEPPER` was not injected, was injected with
a different value, or the secret mount permissions broke.

Verify by hashing a known key and checking the DB:

```sh
# Inside the gateway container
echo -n "ak_known_test_key" \
  | openssl dgst -sha256 -hmac "$API_KEY_HASH_PEPPER" \
  | awk '{print $2}'
# → compare against one row's key_hash in api_keys
```

If the computed hash doesn't match any row, the pepper is wrong. Restore
it.

**If the pepper is permanently lost:** there is no recovery by design —
all existing keys become unverifiable. Reissue every key org-wide.

### 7. Queue lag / DLQ growth

```
gw_queue_depth     > 5_000  (and still climbing)
gw_queue_dlq_count > 0
```

- **DB write lag.** `usage_logs` insert is usually the bottleneck. Check
  `pg_stat_statements` ordered by `mean_exec_time`; common causes are
  index bloat (run `REINDEX CONCURRENTLY`) or disk saturation.
- **Redis contention.** BullMQ queue operations on a slow Redis pile up.
  Same remediation as Scenario 5.
- **Broken worker logic.** If `gw_queue_dlq_count` keeps growing, inspect
  `failedReason` on DLQ jobs — commonly FK violations from orphaned rows
  (key or account deleted between enqueue and dequeue). Fix the data, then
  retry or drain.

If `GATEWAY_REDIS_FAILURE_MODE=strict` and the depth exceeds
`GATEWAY_QUEUE_SATURATE_THRESHOLD` (default 5000), the gateway starts
returning `503 service_degraded` to protect the queue from unbounded
growth.

---

## 9. Schema change policy

Schema changes merged into the gateway tables (or any shared table the
gateway reads) **must stay additive** to keep rollback safe. This policy
applies to every plan after 4A.

**Allowed without a plan gate:**

- New tables
- New nullable columns
- New indexes
- New `CHECK` constraints added `NOT VALID` first, then `VALIDATE`d in a
  later deploy

**Forbidden in 4A (and generally dangerous):**

- Adding a value to an existing enum type — old zod validators / ORM
  readers crash on the unknown value. Use a new column or a text column
  with a `CHECK` constraint instead.
- Changing a column's type or nullability — old readers will error at
  runtime.
- Dropping columns — add a migration to stop reading first, ship that,
  then drop in a follow-up.

**Rollback.** Plan 4A is additive on top of v0.2.0. To roll back:

1. Deploy the previous `apps/web` + `apps/api` images (they ignore the new
   tables and routers cleanly).
2. Stop the `gateway` service (`docker compose --profile gateway down` or
   scale to 0).
3. **Do not** run a down-migration. The 4 new tables stay in place —
   rolling forward reuses the data.
4. Optional: flush Redis gateway state with `redis-cli --scan --pattern
   'caliber:gw:*' | xargs -r redis-cli del`.

`usage_logs` and `credential_vault` survive rollback, so the next rollout
picks up historical data and existing credentials.

---

## 10. Feature flag

`ENABLE_GATEWAY` is defence-in-depth:

| Layer | Mechanism |
|---|---|
| Orchestration | `docker-compose.yml` puts the `gateway` service under `profiles: [gateway]`. Without `--profile gateway`, the container never starts. |
| Process | With `ENABLE_GATEWAY=false` the gateway process boots but skips every route except `/health` (which reports `{"status":"disabled"}`). It does **not** `process.exit` — that would cause an orchestrator restart loop. |
| API | The admin tRPC routers (`accounts.*`, `apiKeys.*`, `usage.*`) throw `TRPCError({ code: "NOT_FOUND" })` when the flag is false. |
| Web UI | Dashboard pages and nav entries are conditionally hidden. Cosmetic — the real gates are above. |

---

## 11. Body Capture (Plan 4B)

The gateway supports opt-in **body capture** — encryption and storage of request
and response bodies for audit, analytics, and evaluation purposes. All capture
is controlled at the organization level via a settings page toggle.

**Encryption.** Captured bodies are encrypted with AES-256-GCM using a
sub-key derived via HKDF-SHA256 from `CREDENTIAL_ENCRYPTION_KEY` with
`salt=capture_id` and `info="caliber-gateway-body-v2"`. This provides domain
separation from account credentials and allows rotation at the org level
without breaking decryption of older captures.

**Retention.** By default, captured bodies are stored for 90 days. Orgs may
customize the retention window (7–365 days) via `/dashboard/organizations/[id]/settings`.
After the retention period, bodies are automatically purged via a nightly
background job. Members may request early deletion via GDPR flows.

**Evaluation.** Captured bodies feed the optional **evaluator subsystem** (Plan
4B), which scores interactions against org-custom rubrics and provides member
feedback + team analytics. See [`EVALUATOR.md`](./EVALUATOR.md) for full
details on the evaluator that consumes captured bodies.

**Configuration.**

| Env | Purpose |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | Master key for body encryption. Also used by gateway account credentials. **Inject via secret mount, never commit.** |
| `ENABLE_EVALUATOR` | Feature flag. When `true`, evaluator scoring jobs are enabled. Requires `ENABLE_GATEWAY=true` + captured bodies. |

---

## 12. Further reading

- Design doc: [`.claude/plans/2026-04-20-plan4a-gateway-design.md`](../.claude/plans/2026-04-20-plan4a-gateway-design.md)
  — 1146 lines, 27-item decision log, full architecture rationale.
- Implementation plan: [`.claude/plans/2026-04-20-plan-4a-gateway.md`](../.claude/plans/2026-04-20-plan-4a-gateway.md)
  — 48 tasks × 13 parts with TDD rhythm.
- Self-hosting bring-up: [`SELF_HOSTING.md`](./SELF_HOSTING.md).
- Local development: [`../apps/gateway/README.md`](../apps/gateway/README.md).
- Compose file: [`../docker/docker-compose.yml`](../docker/docker-compose.yml).
- Env schema source of truth: [`../packages/config/src/env.ts`](../packages/config/src/env.ts).
