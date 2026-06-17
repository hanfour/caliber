# Gateway Multi-User / Concurrency Load-Test Harness — Design (#206)

**Status:** design approved (brainstorm 2026-06-12); Claude+codex-reviewed and user-adjusted; ready for writing-plans.
**Issue:** #206 [launch-prep] Multi-user / concurrency load test of the gateway data plane.
**Goal:** A repeatable harness that (a) **asserts** the gateway's concurrency/isolation invariants under real concurrent multi-user load (correctness gate, CI), and (b) **reports** throughput + p50/p95 latency per surface (perf benchmark, report-only).

---

## 1. Background & Motivation

All real prod traffic so far is 1 user (the operator), ~hundreds of usage rows. The scheduler, Layer-1/Layer-2 sticky, per-account concurrency slots, wait-queue admission, idempotency, and BYOK ownership isolation are built and unit/integration-tested, but **never exercised under real concurrent multi-user load**. #205 (api_key credential health) added a new failover-loop degrade path that is also a regression risk worth gating.

This is the first of the launch-prep tracks. The first version targets **"stable, repeatable, comparable"** — not finding the absolute limit.

---

## 2. Scope Decisions (locked during brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Primary purpose | **Both** correctness gate + perf benchmark | Issue asks for both; they share ~60% infra (boot + seed + fake upstream) so live in one phased spec, not two. |
| System-under-test | **Ephemeral stack + fake upstream** | Harness boots its own Postgres (testcontainer) + **real Redis** (container) + gateway on a **real port** + a configurable fake upstream. Deterministic, zero token cost, real Redis Lua/ZSET semantics, zero prod risk. |
| Perf load driver | **autocannon** (programmatic, Node) | Native p50/p95/p99 + RPS; single language/toolchain; drives from TS so seed + DB-state assertions stay in one place. |
| Correctness driver | In-harness TS concurrency over **real HTTP** | Real socket concurrency (not `app.inject()` in-process). |
| Correctness gate in CI | **Yes** — new serial `load` integration lane | Deterministic pass/fail. |
| Perf benchmark in CI | **No** — report-only `pnpm` script | Perf thresholds on shared runners are flaky; humans watch trends. |

### Why real Redis + real port (differs from existing test convention)

Existing integration tests use `app.inject()` + `ioredis-mock`. Both are disqualifying here:
- The primitives under test (slot acquisition Lua script, wait-queue ZSET) **are** Redis behavior; `ioredis-mock` does not faithfully reproduce Lua/ZSET atomicity under concurrency → mock-based concurrency assertions would be false.
- `app.inject()` shares one in-process event loop → no real connection concurrency.

So the harness stands up a real `redis:7-alpine` testcontainer and calls `app.listen({ port: 0 })`.

### Why serial execution is mandatory (not just for Redis)

`buildServer` registers **process-global prom-client metrics** (single registry). Parallel scenarios in one process would share the same counters → C0 baseline/delta races. Therefore the load lane runs **serial** (`singleThread` / `maxWorkers: 1`), independent of Redis isolation. A single **dedicated** Redis container serves the suite. Per-scenario key-prefixing is **not achievable**: the gateway hardcodes the Redis prefix `caliber:gw:` (`redis/client.ts:29`), slot/wait/auth keys are not scenario-namespaced (`redis/keys.ts:5`), and BullMQ applies its own `caliber:gw` prefix outside ioredis keyPrefix (`workers/usageLogQueue.ts:41`). Because the suite is serial and the Redis container is dedicated, cleanup clears the **entire `caliber:gw*` keyspace** between scenarios via a raw (un-prefixed) Redis client doing `SCAN MATCH caliber:gw*` + `UNLINK` (**never `flushdb`** — but the whole keyspace is ours, so the scoped scan-delete is the clean form). No scenario prefix.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  load-harness (TS)                                        │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │ correctness│   │ perf driver  │   │  shared base    │  │
│  │ TS concur. │   │ autocannon   │   │  bootStack()    │  │
│  │ + asserts  │   │ (report)     │   │                 │  │
│  └─────┬──────┘   └──────┬───────┘   └───────┬────────┘  │
└────────┼─────────────────┼───────────────────┼───────────┘
         │  real HTTP (port 0, real socket concurrency)     │
         ▼                 ▼                     ▼
   ┌───────────────────────────────────┐   bootStack() boots & seeds:
   │ gateway = buildServer().listen()  │   • Postgres (testcontainer) + migrate
   │ real port, real Redis, real sched │   • Redis  (testcontainer redis:7)
   └──────────────┬────────────────────┘   • gateway.listen({port:0})
                  │ UPSTREAM_*_BASE_URL       • seed: 1 org, K members,
                  ▼                            keys across pool/own/own_then_pool
   ┌───────────────────────────────────┐      + BYOK/pool upstreams
   │ fake upstream (node:http, port 0) │   • fake upstream
   │ configurable latency/status/SSE   │
   │ + self request/error counters     │
   └───────────────────────────────────┘
```

### `bootStack()` — the shared foundation

Returns `{ baseUrl, db, redis, fake, seed, env, teardown }`. Both drivers call it. Responsibilities:

1. Start Postgres testcontainer (reuse the `apps/api/tests/factories/db.ts` pattern), run `@caliber/db` migrations.
2. Start `redis:7-alpine` testcontainer.
3. Start the fake upstream (`fakeUpstream.ts`) on `port: 0`.
4. Build `ServerEnv` with `REDIS_URL` pointed at the Redis container, `UPSTREAM_ANTHROPIC_BASE_URL` **and** `UPSTREAM_OPENAI_BASE_URL` pointed at the fake's address, `GATEWAY_ENABLE_MODEL_ALIAS=false`, and the concurrency/queue/auth knobs at **suite-level fixed values** (`GATEWAY_MAX_WAIT=W`, `GATEWAY_MAX_ACCOUNT_SWITCHES=S`, `GATEWAY_UPSTREAM_AUTH_MAX_FAIL=N`). These are captured at plugin-registration time (e.g. `waitQueuePlugin.ts:38` reads `maxWait` into a const) and **cannot be mutated per scenario** under one long-lived gateway. Scenarios that need a specific threshold derive their request counts from these fixed `seed.env` values (e.g. C3 fires `W+1`), rather than changing env. Per-account variation (concurrency) still goes through DB columns and is freely per-scenario.
5. `buildServer({ env, db })` **without** injecting `opts.redis`, then `app.listen({ port: 0, host: '127.0.0.1' })`; capture `baseUrl`. (`buildServer` returns an un-listened Fastify app — only `main()` listens — so the harness owns `listen`. `port: 0` is the OS-ephemeral-port `listen` arg and is unrelated to `GATEWAY_PORT`, which the env schema still requires to be ≥1 even though it's unused here — `server.ts:133`, `env.ts:83`.)
6. Run the seed (`seed.ts`).
7. The harness opens **its own** Redis client(s) to the same container — a `caliber:gw:`-prefixed client for slot-ZSET inspection, and a **raw un-prefixed** client for cleanup (`SCAN MATCH caliber:gw*` + `UNLINK`) — separate from the gateway's internal client.
8. `teardown()` closes the app, both containers, and the fake server.

**Critical wiring constraint (verified against code).** `buildServer` infers "this is a test" from `opts.redis` being **present** and, when so, **skips BullMQ queue/worker/audit instantiation entirely** (`apps/gateway/src/server.ts:107-118`). If the harness injects Redis via `opts.redis`, `app.usageLogQueue` stays `undefined`, and every usage write is silently skipped (`usageLogging.ts:612`) — so `usage_logs` would be **empty** and C1/C5/C6 would have nothing to assert. Therefore the harness drives the gateway via the **production path**: it sets `REDIS_URL` env to the container and leaves `opts.redis` undefined, so `buildServer` builds its own real Redis client and runs the real BullMQ queue + worker against the real container. (`opts.db` injection is independent of this gate and is fine.)

With the queue+worker live, the harness **drains the usage queue** before asserting `usage_logs` rows. There is no exposed worker-drain API and the worker batches on a ~1000ms timer (`usageLogWorker.ts:53/285`), so `drainUsageQueue.ts` polls BullMQ `getJobCounts` **and** the expected `usage_logs` row count until both settle (the pattern used by `usageLogWiring.integration.test.ts:319`). Attribution/billing assertions run only after the drain.

**All five surfaces resolve their upstream base URL from `opts.env.UPSTREAM_{ANTHROPIC,OPENAI}_BASE_URL`** (not from a per-account column) — e.g. `messages.ts:151`, `chatCompletions.ts:147`, `responses.ts:210/336`. So one fake server behind those two env vars covers every surface; the seeded accounts are differentiated by the **credential token** the fake receives (the `credentialHealth.integration.test.ts` pattern). Note: `UPSTREAM_ANTHROPIC_BASE_URL` has a hard fallback to `https://api.anthropic.com` when empty (`messages.ts:152`), so the harness **must set it explicitly** or anthropic surfaces would hit the real API.

### `fakeUpstream.ts` — one server, three upstream shapes

Serves the response shapes the gateway actually calls upstream (verified — the gateway never calls upstream `/v1/chat/completions`; the chat-completions surface pivots to Anthropic `/v1/messages` or OpenAI `/v1/responses`, and codex is forced to OpenAI Responses — `upstreamCall.ts:67`, `upstreamCallOpenai.ts:48/112`, `codexResponses.ts:37`):
- Anthropic `POST /v1/messages` (non-stream JSON + SSE stream)
- OpenAI `POST /v1/responses` (non-stream JSON + SSE stream)
- OpenAI `POST /v1/responses/compact` (non-stream)
- `GET /v1/models` — see model-alias note below.

**Model-alias refresh must be neutralized.** `GATEWAY_ENABLE_MODEL_ALIAS` defaults on and the registry's background refresh starts on the real-Redis boot path, fetching `${baseUrl}/v1/models` (`env.ts:199`, `server.ts:223`, `modelCatalogFetch.ts:17`). The harness either sets `GATEWAY_ENABLE_MODEL_ALIAS=false` (default — the load test does not exercise alias resolution) **or** the fake serves a static `/v1/models`. Default to disabling it.

Configurable **per-route or globally**:
- **latency**: fixed ms (and optionally a simple distribution) before responding — to create slot saturation (correctness) and to isolate gateway overhead (perf).
- **status injection**: force 200 / 401 / 403 / 429 / 503 / timeout, optionally keyed by the credential token presented (the `credentialHealth.integration.test.ts` pattern) so different seeded accounts get different fates.
- **SSE mode**: emit a valid event stream with a controllable first-token delay.
- **self counters**: tracks its own request count + error count, exposed for assertions and for the perf report (to prove the fake was not itself the bottleneck, especially at 0ms latency).

The fake must sustain the target connection count; if it saturates, that is surfaced in the report rather than silently skewing numbers.

---

## 4. Correctness Gate (C0–C8a)

Runs as vitest integration tests in the serial `load` lane. Each scenario seeds under a unique **scenario slug** and cleans up after itself.

### Cross-cutting rules

- **C0 baseline = delta, always.** Each scenario reads counters once at start, once at end, and compares the **delta**. Never assume counters are zero (prom-client retains registered metrics / initial 0-series even when serial). DB and Redis are cleaned between scenarios; metrics use delta.
- **Metrics are read in-process, not over HTTP.** The public `/metrics` route is **not** in `PUBLIC_PATHS` and returns 401 (`apiKeyAuth.ts:46/51`, asserted by `server.test.ts:75`), and `buildServer` does **not** start the private metrics listener (only `main()` calls `startMetricsServer()`, `server.ts:679`). So the harness reads the prom-client global registry directly from the in-process app — `app.metrics.client.register.getMetricsAsJSON()` (or `.metrics()`) — via `scrapeMetrics.ts`. No HTTP scrape, no private server boot.
- **Fixture id naming.** Every org / user / upstream_account / api_key / request id carries the scenario slug, so DB joins, metric labels, and reports line up and C1/C5 can make precise joins.
- **Isolation.** `afterEach`: `TRUNCATE ... RESTART IDENTITY CASCADE` the data tables **and** clear the whole `caliber:gw*` Redis keyspace (`SCAN MATCH caliber:gw*` + `UNLINK` via the raw client — see §2; per-scenario prefixing is not achievable). `usage_logs` has `RESTRICT` FKs to `users`/`api_keys`/`upstream_accounts`/`organizations`, and `request_bodies`/`request_body_facets` hang off `usage_logs`; `idempotency_records`, `credential_vault`, and account-group membership are additional dependent state (`usageLogs.ts:25`, `requestBodies.ts:9`, `requestBodyFacets.ts:26`, `idempotencyRecords.ts:23`, `credentialVault.ts:21`, `accountGroups.ts:57`). So `CASCADE` (or a fully ordered child-first list) is required — a naive truncate of `usage_logs` alone fails on the RESTRICT FKs. Migrations are preserved. Cleaning only Redis is insufficient — leftover rows would pollute subsequent delta/join assertions.
- **Assertion sources (triangulated, no mock theater):** HTTP status + error-body shape, real `usage_logs` rows, real Prometheus counter deltas, and (where relevant) direct Redis slot-ZSET inspection.

### Scenarios

| # | Scenario | Setup | Assertions |
|---|---|---|---|
| **C0** | Harness sanity | fresh boot, baseline scrape | DB/Redis baseline clean (or unique-label delta); a single trivial 200 request flows end-to-end and writes exactly one `usage_logs` row. Smoke for the harness itself. |
| **C1** | Attribution isolation | K members, each with their **own** BYOK upstream; fake all-200 | Concurrent N requests across members → drain queue → every `usage_logs` row's `user_id`/`account_id` matches its caller; **zero** cross-user leak (`JOIN upstream_accounts ON account_id WHERE upstream_accounts.user_id IS NOT NULL AND <> usage.user_id` = 0 rows); BYOK `own` traffic lands only on the caller's own upstream. |
| **C1b** | own-policy, no own upstream (negative) | `own`-policy key whose user owns **no** upstream | Request returns `409 no_own_upstream`; **must not** fall through to the org pool (anti-fallback-leak). |
| **C2** | Slot cap (deterministic) | **single account**, no other candidates; `concurrency=K`; fake slow (holds slots) | Concurrent N>K → first K acquire and proceed (200). **The no-over-allocation invariant is asserted via the metric**: `gw_slot_acquire_total{result=over_limit}` delta == N−K (the true proof — independent of HTTP shape). The shed requests return **`503 { error: "all_upstreams_failed", attempted_count: 1 }`** — **not** `account_at_capacity`: a `CapacityError` thrown inside the failover loop's `attempt` is treated as a failed attempt; with a single account the loop exhausts → `AllUpstreamsFailed`. This is the documented behavior of the existing `messages.integration.test.ts:428` test. (`account_at_capacity` only surfaces when a `CapacityError` escapes the loop entirely — a different path not exercised here.) No "or failover" branch. **Use `N ≤ W`** (the suite-fixed `GATEWAY_MAX_WAIT`) so the overflow requests are shed at the **slot** layer, not pre-empted by a wait-queue `429`. |
| **C3** | Wait-queue admit/shed | `GATEWAY_MAX_WAIT=W`; fake slow; **account concurrency set high** so the only bottleneck is W (else requests hit slot 503 before queue 429) | Single user fires M>W → first W proceed, the rest return `429 wait_queue_full` (correct shape); after the queue drains, new requests admit again. |
| **C4-L1** | Sticky — Responses `previous_response_id` | multiple accounts; same `previous_response_id` | ① same session initially all hit the **same** account; ② when the sticky target is forced to fail, that request **failovers to a healthy account**; ③ subsequent requests with the same sticky key **rebind to / stay on the new healthy account** (not back to the dead target). |
| **C4-L2** | Sticky — Messages/Chat session header | multiple accounts; same `X-Claude-Session-Id` | Same three assertions as C4-L1, tested independently. |
| **C5** | Idempotency (non-stream only) | same `X-Request-Id` | ① concurrent same-id → **exactly one** reaches upstream, the rest `409`; ② after completion, replay is **byte-identical**; ③ `usage_logs` has **exactly one** row (no double-billing); ④ a non-2xx response is **not cached** (explicit assertion). |
| **C6** | Failover pressure | seed `badCount = MAX_ACCOUNT_SWITCHES − 1` accounts forced 503 + 1 healthy (healthy falls within the switch budget) | Request retries through the bad accounts and succeeds on the healthy one; no double-billing. **Separate all-bad case**: every account 503 → request returns `503 all_upstreams_failed` (correct shape). Two scenarios, not one branch-expectation. |
| **C7** | Streaming correctness | fake SSE mode | Each concurrent stream receives a complete, uncorrupted SSE sequence; concurrent streams do not cross-contaminate; **slot release verified by a follow-up request OR direct Redis slot-ZSET inspection** (not Prometheus alone); `firstTokenMs` asserted **non-null / positive** only (no exact-timing assertion). |
| **C8a** | Credential-health degrade (#205 regression, gateway-only) | fake returns 401 repeatedly for one api_key account | After N=`GATEWAY_UPSTREAM_AUTH_MAX_FAIL` 401s: **only that** api_key account is degraded, its `status` stays **active**, `tempUnschedulableReason='api_key_invalid_credential'`, the degrade metric increments **+1**; a **403 neither degrades nor resets** the counter. This is pure gateway data plane (the failover-loop record path), so it lives in this gate. |

### C8b (rotation recovery) — out of scope for this gateway-only harness

The other half of the #205 contract — **rotate clears the temp fields + Redis counter and sets the grace window** — is driven by the `accounts.rotate` / `rotateOwn` tRPC procedures in **apps/api** (`accounts.ts:348`, `accounts.ts:545`), not the gateway data plane. `bootStack()` only stands up the gateway + fake upstream, so it **cannot** exercise the API rotate path without also booting an API tRPC caller/server — out of scope here. C8b stays where it belongs: the **apps/api integration suite** (the #205 `_credentials.resetApiKeyCredentialHealth` coverage). This harness must not pretend a gateway-only stack tests API rotation.

### Rate-limit — explicitly excluded from the gate

The sliding-window rate limiter is **not** in C0–C8. Measuring a real-clock minute bucket is slow/flaky. It is covered separately by a small test: a Redis-helper unit test asserting bucket counts, plus a middleware smoke asserting the N+1th request returns `429` — **without** waiting for window turnover. Admission into the gate later requires **clock injection** first.

---

## 5. Perf Benchmark (report-only)

A repeatable `pnpm perf:gateway` script. Boots the same `bootStack()`, drives autocannon against the real port, prints a report and writes `docs/perf/<date>-gateway-load.md`.

### Matrix

Each cell = one surface × one upstream-latency setting:
- **Surfaces (5):** `messages`, `chat-completions`, `responses`, `codex-responses` (the `/v1/responses` codex-compat route — named distinctly to avoid confusion with plain `responses`), `streaming` (SSE).
- **Fake upstream latency:** `0ms` (pure gateway overhead — middleware/DB/Redis/serialization), `50ms` (fast upstream / LAN / cache-ish provider), `200ms` (closer to real LLM TTFB, where gateway cost is amortized).
- **connections × duration:** fixed per run, CLI-overridable (default e.g. 50 connections × 20s).

### Steady-state, not shed

Each round explicitly configures away the shed paths so the benchmark measures gateway steady-state:
- response cache off **or** request keys uniquified;
- **no** idempotency header;
- account concurrency / wait-queue / rate-limit set high enough to **not** bottleneck.

### Payload

At least one **fixed small** payload in v1; optionally a **medium** payload. **Never** randomize content per round (it dirties p99 comparisons).

### Warmup via discard round

Each matrix cell first runs a short warmup autocannon whose results are **discarded**, then the measured round. (Does not rely on autocannon's native warmup.)

### Report contents

Written to `docs/perf/<date>-gateway-load.md`, with **environment metadata** (without it, report-only numbers can't be compared across time):
- git sha, Node + pnpm versions, OS / CPU, connections/duration, payload size, fake latency, key env values.

Per matrix cell:

| Field | Source |
|---|---|
| surface / upstream latency | matrix params |
| RPS (throughput) | autocannon |
| p50 / p95 / p99 / max latency | autocannon histogram |
| non-2xx rate, timeouts | autocannon |
| fake upstream request/error count | fake self counters (proves fake ≠ bottleneck) |
| streaming: `first_token_p50/p95` | harness client-side (SSE first byte) |
| streaming: `stream_complete_p50/p95` | autocannon (full stream completion) |
| derived gateway net overhead | `p50(surface) − upstream_latency` |

**Streaming metrics are kept separate** — autocannon's latency for SSE is full-stream-completion time; `firstTokenMs` is measured client-side. Report both, never merged into one "latency".

---

## 6. File Structure

```
apps/gateway/tests/load/
  README.md               # optional: how to run the lane (mirrors §8 runbook)
  bootStack.ts            # §3 foundation; returns {baseUrl,db,redis,fake,seed,env,teardown}
  fakeUpstream.ts         # configurable fake: 3 upstream shapes + latency/status/SSE + self counters
  seed.ts                 # 1 org, K members, keys across pool/own/own_then_pool + BYOK/pool upstreams; slug-namespaced ids
  scrapeMetrics.ts        # prom scrape → parse → delta helper
  assertions.ts           # shared: error-body shape, usage-log drain, metric delta, fake-count asserts (thin, NOT a framework)
  cleanup.ts              # afterEach: TRUNCATE ... RESTART IDENTITY CASCADE + SCAN MATCH caliber:gw* + UNLINK (raw client)
  drainUsageQueue.ts      # poll getJobCounts + DB row count until idle (no worker drain API; 1000ms batch timer)
  correctness/
    *.integration.test.ts # C0-C8a, one file per scenario group (C8b rotation lives in apps/api)
  vitest.load.config.ts   # serial (singleThread/maxWorkers:1); collects tests/load/correctness/**

scripts/
  perf-gateway.ts         # §5 autocannon matrix driver → pnpm perf:gateway; report-only

docs/perf/
  <date>-gateway-load.md  # generated report (with metadata)
```

### Harness self-verification

To avoid harness bugs turning green into false red (or vice versa):
- `fakeUpstream.ts` and `seed.ts` each get a thin unit test (fake returns the configured status/latency/SSE; seed really creates K×policy keys/upstreams).
- `scrapeMetrics.ts` gets a unit test — label parsing is easy to get wrong and would cause false greens.
- The C0 sanity scenario doubles as a smoke test for the whole harness.

---

## 7. Non-Goals (YAGNI boundaries)

- ❌ Saturation / staircase probing (revisit after the v1 baseline curve exists; otherwise the report-only script grows into a second load-harness project).
- ❌ Real upstreams / real token cost (that is the request-path smoke's domain).
- ❌ Rate-limit sliding-window in the gate (needs clock injection; covered by a small separate test).
- ❌ Full medium/large payload matrix (v1 = small payload; medium optional).
- ❌ Perf thresholds as a CI gate (report-only; humans watch trends).
- ❌ Multi-machine / distributed load generation (single-machine autocannon is enough for v1).
- ❌ **Provider protocol full compatibility.** The fake upstream only covers the response shapes the gateway needs; it does **not** validate Anthropic/OpenAI real protocol edge cases. This harness is not an upstream contract test.

---

## 8. Runbook

```bash
# Correctness gate (CI lane; needs Docker for Testcontainers — Postgres + Redis):
pnpm --filter @caliber/gateway test:load

# Perf benchmark (report-only, manual/periodic; needs Docker):
pnpm perf:gateway                 # default matrix
pnpm perf:gateway -- --connections 100 --duration 30   # override

# Output: docs/perf/<date>-gateway-load.md  (includes env metadata for trend comparison)
```

Both require Docker / Testcontainers (Postgres + Redis containers). The correctness lane is serial by design. The perf script does not run in CI.

---

## 9. Verified Findings & Remaining Plan-Stage Questions

Reviewed by **Claude + codex** (both grounded in the real repo, file:line-cited; cross-verified against the code). codex independently confirmed the two High findings below and added four more (metrics scrape path, C2 capacity shape, TRUNCATE CASCADE, fake paths / model-alias) — all verified and folded into §§3–6 above.

### codex-added findings (verified, folded above)

- **[High] Metrics can't be HTTP-scraped from the harness.** Public `/metrics` is not in `PUBLIC_PATHS` → 401 (`apiKeyAuth.ts:46/51`, `server.test.ts:75`); `buildServer` does not start the private metrics listener (only `main()` → `startMetricsServer()`, `server.ts:679`); `metricsPlugin` uses `clearRegisterOnInit:true` (`metrics.ts:100`). → harness reads the in-process prom-client global registry directly (folded into §3/§4); reinforces the **single long-lived gateway** decision (a re-boot would `clearRegisterOnInit` and wipe counters).
- **[High] C2 capacity shape is `all_upstreams_failed`, not `account_at_capacity`** for a single full account — verified against the existing `messages.integration.test.ts:428` which documents exactly this. C2 rewritten (assert no-over-allocation via the `over_limit` metric delta; shed requests are `503 all_upstreams_failed{attempted_count:1}`).
- **[High] TRUNCATE needs CASCADE** — `usage_logs` RESTRICT FKs + dependent tables. Folded into §4/§6.
- **[Med] Fake upstream paths** — the gateway never calls upstream `/v1/chat/completions`; needs `/v1/messages`, `/v1/responses`, `/v1/responses/compact` (+SSE). Plus model-alias refresh fetches `/v1/models` and must be disabled (or served). Folded into §3.
- **[Med] Queue-drain method** — no drain API; poll `getJobCounts` + DB row count. Folded into §3/§6.
- **[confirmed] Real-Redis justification, 60s slot caveat, C4 sticky rebind correctness, exact error shapes** — codex cross-confirmed all of these.

### User spec-review adjustments (folded before finalizing)

- **[High] C8 split** — rotation recovery (clear temp/counter + grace) is an apps/api tRPC path (`accounts.ts:348/545`), not the gateway data plane, so a gateway-only harness can't test it. The gate keeps **C8a** (401 degrade / 403 no-reset, pure failover-loop); **C8b** (rotation recovery) stays in apps/api integration. Folded into §4.
- **[High] Per-scenario Redis prefix is not achievable** — gateway prefix is hardcoded `caliber:gw:` (`redis/client.ts:29`), keys aren't scenario-namespaced (`redis/keys.ts:5`), BullMQ uses its own `caliber:gw` prefix (`usageLogQueue.ts:41`). Cleanup clears the whole `caliber:gw*` keyspace via a raw client (suite serial + dedicated container makes this safe). Folded into §2/§4/§6.
- **[Med] One long-lived gateway vs per-scenario env** — `GATEWAY_MAX_WAIT` etc. are captured as consts at plugin registration (`waitQueuePlugin.ts:38`), so they're **fixed suite-wide**; scenarios derive request counts from the fixed values, only per-account DB columns vary. C2 must use `N ≤ W` so overflow sheds at the slot layer, not the wait-queue. Folded into §3/§4.

### Verified against the code during spec review (fold into Task 1)

- **[High] prom-client registry is a process-global singleton.** The metrics plugin registers every counter against `fastify.metrics.client.register` — the prom-client **default global registry** (`apps/gateway/src/plugins/metrics.ts:100-109`, comment: "Owns the prom-client default singleton"). Booting a second gateway in the same process would re-register the same metric names against the same global registry → throw or accumulate. **Resolution:** boot **one long-lived gateway for the whole serial suite** and reuse it across scenarios — between scenarios only TRUNCATE DB (CASCADE) + clear the `caliber:gw*` Redis keyspace + take metric **deltas**. This matches the C0 delta rule and is faster than boot-per-scenario. The boot-time env knobs (`GATEWAY_MAX_WAIT`, `GATEWAY_MAX_ACCOUNT_SWITCHES`, `GATEWAY_UPSTREAM_AUTH_MAX_FAIL`) are captured at plugin registration and **fixed suite-wide** (§3 step 4); scenarios derive request counts from those fixed values instead of mutating env. Only per-account columns (concurrency, ownership, platform, status) vary per scenario. No re-boot, so no `clearRegisterOnInit`/`register.clear()` churn.
- **[High] usage-queue gating** — resolved in §3: drive via `REDIS_URL` env, do **not** inject `opts.redis`, or `usage_logs` stays empty (`server.ts:107-118`, `usageLogging.ts:612`).
- **[Med] anthropic base-URL hard fallback** — resolved in §3: the harness must set `UPSTREAM_ANTHROPIC_BASE_URL` explicitly (`messages.ts:152`).
- **[Med] exact error-body shapes to assert** (verified): `429 { error: "wait_queue_full", maxWait }` (`waitQueuePlugin.ts:61`); `409 { error: "no_own_upstream", ... }` (`noOwnUpstream.ts:37`); `503 { error: "account_at_capacity" }` (`messages.ts:252`, thrown as `{ status:503, message:"account_at_capacity" }` `withSlotAndCredential.ts:63`); `{ error: "all_upstreams_failed", request_id }` (`messages.ts`, `sseErrorEvents.ts:188`); idempotency in-flight is **`409 request_in_progress` + Retry-After** (`idempotencyCache.ts:8`), not a bare "conflict".
- **[Med] C4 sticky rebind is real but setup-sensitive.** `bindStickyKeys` runs at L1-hit, L2-hit, and cold-path selection (`scheduler.ts:327/367/431`); when a sticky target is **unschedulable**, select self-heals to the cold path and rebinds to the new healthy account (`scheduler.ts:431`). So C4 assertion ③ holds **only if the scenario makes the dead target genuinely unschedulable** (disable/degrade it) before the follow-up request. To assert ② (per-request failover) instead, the target fails at attempt-time while staying schedulable. The plan must set these two sub-cases up distinctly.

### Remaining questions for the plan

- Exact K (member count) and N (concurrent request count) per scenario — smallest values that deterministically exercise each invariant (keep CI fast).
- Whether `test:load` runs in the existing gateway-integration CI job or a new dedicated job (leaning: **dedicated** — it adds a Redis container, runs serial, and boots a real listening port).
- The slot 60s `EXPIRE` safety net (`slots.ts`) is far longer than any scenario; C2/C7 rely on the `finally` `releaseSlot` for prompt release and on fake latency to hold slots — confirm no scenario depends on the 60s expiry firing.
