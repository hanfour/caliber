# Gateway Multi-User / Concurrency Load-Test Harness — Design (#206)

**Status:** design approved (brainstorm 2026-06-12), pending codex review + plan.
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

`buildServer` registers **process-global prom-client metrics** (single registry). Parallel scenarios in one process would share the same counters → C0 baseline/delta races. Therefore the load lane runs **serial** (`singleThread` / `maxWorkers: 1`), independent of Redis isolation. A single Redis container serves the suite; isolation is per-scenario key-prefix cleaned with `SCAN` + `UNLINK` (**never `flushdb`** — it ignores prefixes and would wipe sibling scenarios).

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
2. Start `redis:7-alpine` testcontainer; client uses keyPrefix `caliber:gw:` (matches prod).
3. Start the fake upstream (`fakeUpstream.ts`) on `port: 0`.
4. Build `ServerEnv` with `UPSTREAM_ANTHROPIC_BASE_URL` / `UPSTREAM_OPENAI_BASE_URL` pointed at the fake's address, plus per-scenario concurrency/wait knobs.
5. `buildServer({ env, db, redis })` then `app.listen({ port: 0, host: '127.0.0.1' })`; capture `baseUrl`.
6. Run the seed (`seed.ts`).
7. `teardown()` closes the app, both containers, and the fake server.

With **real Redis**, BullMQ usage-log queue + worker are active. The harness **drains the usage queue** (awaits queue idle) before asserting `usage_logs` rows, so attribution/billing assertions are deterministic.

### `fakeUpstream.ts` — one server, three upstream shapes

Serves the response shapes the gateway needs from each upstream:
- Anthropic `POST /v1/messages` (non-stream JSON + SSE stream)
- OpenAI `POST /v1/chat/completions`
- OpenAI `POST /v1/responses`

Configurable **per-route or globally**:
- **latency**: fixed ms (and optionally a simple distribution) before responding — to create slot saturation (correctness) and to isolate gateway overhead (perf).
- **status injection**: force 200 / 401 / 403 / 429 / 503 / timeout, optionally keyed by the credential token presented (the `credentialHealth.integration.test.ts` pattern) so different seeded accounts get different fates.
- **SSE mode**: emit a valid event stream with a controllable first-token delay.
- **self counters**: tracks its own request count + error count, exposed for assertions and for the perf report (to prove the fake was not itself the bottleneck, especially at 0ms latency).

The fake must sustain the target connection count; if it saturates, that is surfaced in the report rather than silently skewing numbers.

---

## 4. Correctness Gate (C0–C8)

Runs as vitest integration tests in the serial `load` lane. Each scenario seeds under a unique **scenario slug** and cleans up after itself.

### Cross-cutting rules

- **C0 baseline = delta, always.** Each scenario scrapes Prometheus once at start, once at end, and compares the **delta**. Never assume counters are zero (prom-client retains registered metrics / initial 0-series even when serial). DB and Redis are cleaned between scenarios; Prometheus uses delta.
- **Fixture id naming.** Every org / user / upstream_account / api_key / request id carries the scenario slug, so DB joins, metric labels, and reports line up and C1/C5 can make precise joins.
- **Isolation.** `afterEach`: `TRUNCATE` the data tables (`usage_logs`, `upstream_accounts`, `api_keys`, `credential_vault`, org/user/membership rows — migrations preserved) **and** `SCAN` + `UNLINK` the scenario Redis prefix. Cleaning only Redis is insufficient — leftover `usage_logs`/`upstream_accounts` rows would pollute subsequent delta/join assertions.
- **Assertion sources (triangulated, no mock theater):** HTTP status + error-body shape, real `usage_logs` rows, real Prometheus counter deltas, and (where relevant) direct Redis slot-ZSET inspection.

### Scenarios

| # | Scenario | Setup | Assertions |
|---|---|---|---|
| **C0** | Harness sanity | fresh boot, baseline scrape | DB/Redis baseline clean (or unique-label delta); a single trivial 200 request flows end-to-end and writes exactly one `usage_logs` row. Smoke for the harness itself. |
| **C1** | Attribution isolation | K members, each with their **own** BYOK upstream; fake all-200 | Concurrent N requests across members → drain queue → every `usage_logs` row's `user_id`/`account_id` matches its caller; **zero** cross-user leak (`JOIN upstream_accounts ON account_id WHERE upstream_accounts.user_id IS NOT NULL AND <> usage.user_id` = 0 rows); BYOK `own` traffic lands only on the caller's own upstream. |
| **C1b** | own-policy, no own upstream (negative) | `own`-policy key whose user owns **no** upstream | Request returns `409 no_own_upstream`; **must not** fall through to the org pool (anti-fallback-leak). |
| **C2** | Slot cap (deterministic) | **single account**, no other candidates (or `MAX_ACCOUNT_SWITCHES=1`); `concurrency=K`; fake slow (holds slots) | Concurrent N>K → first K acquire and proceed; the rest return a fixed `503 account_at_capacity`; **no over-allocation**; `gw_slot_acquire_total{result=over_limit}` delta matches the overflow count. No "or failover" branch. |
| **C3** | Wait-queue admit/shed | `GATEWAY_MAX_WAIT=W`; fake slow; **account concurrency set high** so the only bottleneck is W (else requests hit slot 503 before queue 429) | Single user fires M>W → first W proceed, the rest return `429 wait_queue_full` (correct shape); after the queue drains, new requests admit again. |
| **C4-L1** | Sticky — Responses `previous_response_id` | multiple accounts; same `previous_response_id` | ① same session initially all hit the **same** account; ② when the sticky target is forced to fail, that request **failovers to a healthy account**; ③ subsequent requests with the same sticky key **rebind to / stay on the new healthy account** (not back to the dead target). |
| **C4-L2** | Sticky — Messages/Chat session header | multiple accounts; same `X-Claude-Session-Id` | Same three assertions as C4-L1, tested independently. |
| **C5** | Idempotency (non-stream only) | same `X-Request-Id` | ① concurrent same-id → **exactly one** reaches upstream, the rest `409`; ② after completion, replay is **byte-identical**; ③ `usage_logs` has **exactly one** row (no double-billing); ④ a non-2xx response is **not cached** (explicit assertion). |
| **C6** | Failover pressure | seed `badCount = MAX_ACCOUNT_SWITCHES − 1` accounts forced 503 + 1 healthy (healthy falls within the switch budget) | Request retries through the bad accounts and succeeds on the healthy one; no double-billing. **Separate all-bad case**: every account 503 → request returns `503 all_upstreams_failed` (correct shape). Two scenarios, not one branch-expectation. |
| **C7** | Streaming correctness | fake SSE mode | Each concurrent stream receives a complete, uncorrupted SSE sequence; concurrent streams do not cross-contaminate; **slot release verified by a follow-up request OR direct Redis slot-ZSET inspection** (not Prometheus alone); `firstTokenMs` asserted **non-null / positive** only (no exact-timing assertion). |
| **C8** | Credential-health gate (#205 regression) | fake returns 401 repeatedly for one api_key account | After N=`GATEWAY_UPSTREAM_AUTH_MAX_FAIL` 401s: **only that** api_key account is degraded, its `status` stays **active**, `tempUnschedulableReason='api_key_invalid_credential'`, the degrade metric increments **+1**; a **403 neither degrades nor resets** the counter; a rotate clears the temp fields + counter and sets the grace window. |

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
  cleanup.ts              # afterEach: TRUNCATE data tables + SCAN/UNLINK Redis prefix
  correctness/
    *.integration.test.ts # C0–C8, one file per scenario group
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

## 9. Open Questions for Plan Stage

- Exact K (member count) and N (concurrent request count) per scenario — pick the smallest values that deterministically exercise each invariant (keep CI fast).
- Whether `test:load` runs in the existing gateway integration CI job or a new dedicated job (leaning: dedicated job, since it adds a Redis container and is serial).
- Confirm `buildServer` cleanly supports `app.listen` + repeated boot/teardown without leaking the prom-client global registry across scenarios (may need `register.clear()` or a fresh registry per boot — investigate in Task 1).
