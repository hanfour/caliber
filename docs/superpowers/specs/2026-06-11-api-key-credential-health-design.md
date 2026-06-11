# api_key Upstream Credential Health — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — ready for plan
**Issue:** #205 (launch-prep)
**Scope:** Caliber gateway — detect a dead/rejected **api_key** upstream credential, degrade its health so the scheduler stops routing to it, and surface it for rotation.

## Problem

When an `api_key` upstream's stored credential is invalid (revoked / wrong / expired), the upstream provider returns **401/403** (`authentication_error` / `invalid x-api-key`). Today the gateway forwards that 4xx straight back to the client and records **no health state** against the account — the account stays `status='active', schedulable=true` and keeps getting scheduled, so every pool/own request that lands on it fails. There is no signal to the operator/member that the credential is dead.

**Confirmed root cause.** The route attempt callbacks treat all 4xx as a client error and **return** the response directly instead of **throwing** it into the failover loop:

```
// apps/gateway/src/routes/messages.ts (and the 3 sibling routes)
if (upstream.status >= 400 && upstream.status < 500) {
  return upstream;   // forwarded to client; NEVER reaches the failover classifier
}
```

The failover classifier (`packages/gateway-core/src/stateMachine/classifier.ts:18-23`) *does* classify 401/403 as `auth_invalid` → `switch_account` with `stateUpdate.status='error'`, but that path is only reached when an attempt **throws**. A returned 4xx never reaches it, so `applyAccountStateUpdate` is never called. This is exactly why the prod pool `anthropic api_key` (401 `invalid x-api-key`) stayed `active`.

This was surfaced during the 2026-06-11 v0.13.0 prod rotation flow and is a launch-prep reliability gap for multi-user BYOK.

## Goal & Non-Goals

**Goal:** A persistently-rejecting `api_key` upstream is **auto-paused** after N consecutive auth failures, **auto-recovers** on a later success (or on credential rotation), and is **surfaced** to the operator/member with an actionable "rotate this credential" affordance. Observable via metrics.

**Non-Goals:**
- NOT auto-failover on a 401 (try another account in-request). 401 still returns to the client; degradation only changes *future* scheduling. (Future enhancement; larger behavior change.)
- NOT health-tracking other 4xx (400/404/422 = client/request error, not the account's fault).
- NOT touching the **OAuth** path — oauth already has its own `invalid_grant` / `refresh_exhausted` degradation + re-onboard flow (`apps/gateway/src/runtime/oauthRefresh.ts:538-615`). This feature is the **api_key** analog.
- NO schema change / migration (consecutive-failure counter lives in Redis; degraded *state* reuses existing `upstream_accounts` columns).

## Decisions (brainstormed)

| # | Decision |
|---|----------|
| Trigger | **Threshold:** degrade after **N consecutive** auth failures (401/403), `GATEWAY_UPSTREAM_AUTH_MAX_FAIL` default **3**. Reset on any 2xx. Avoids pausing a healthy account on a one-off auth blip. |
| Counter store | **Redis** (`gw:authfail:<accountId>`) — zero migration; `INCR` per auth failure, `DEL` on success; generous safety TTL. The degraded *state* is written to the DB (scheduler + UI need it). |
| Recovery | **Timed backoff:** degrade sets `tempUnschedulableUntil = now + GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC` (default **3600s**). After the window the scheduler retries; a later 2xx clears the degradation, a repeat 401 re-arms it (bounded churn — one retry per window). **Credential rotation (#203 `accounts.rotate`) also clears it immediately.** |
| Auth-class only | Only **401/403** count. Other 4xx untouched. |
| Failover | 401 still returns to the client (no in-request failover). Degradation only affects future scheduling. |

## Detection + degradation flow (gateway runtime)

New module **`apps/gateway/src/runtime/upstreamAuthHealth.ts`** with two side-effecting helpers, called from each route's existing branches:

```
recordAuthFailure(deps, account, status, bodyText?) -> Promise<void>
  // called in the route's 4xx branch when status ∈ {401,403} (BEFORE returning to client)
  if status not in {401,403}: return                 // other 4xx → no-op
  const n = await redis.INCR(`gw:authfail:${account.id}`)        // refresh safety TTL
  metrics.upstreamAuthFailedTotal.inc({ platform })
  if n >= GATEWAY_UPSTREAM_AUTH_MAX_FAIL:
    await db.update(upstreamAccounts).set({
      status: "error",
      tempUnschedulableUntil: now + GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC,
      tempUnschedulableReason: "api_key_invalid_credential",
      errorMessage: truncate(bodyText ?? `upstream ${status}`, 1000),
    }).where(id = account.id)                          // NOT schedulable=false (that's the manual kill-switch)
    metrics.upstreamCredentialDegradedTotal.inc({ platform })   // alertable signal

clearAuthFailure(deps, accountId) -> Promise<void>
  // called on the 2xx success path of each route
  await redis.DEL(`gw:authfail:${accountId}`)
  // self-heal: if this account is currently degraded for a credential problem, recover it
  await db.update(upstreamAccounts).set({
    status: "active", tempUnschedulableUntil: null,
    tempUnschedulableReason: null, errorMessage: null,
  }).where(and(id = accountId, tempUnschedulableReason = "api_key_invalid_credential"))
```

Both helpers are **best-effort and never throw into the request path** (swallow Redis/DB errors; a health-tracking failure must never break a real response) — mirroring the gateway's existing fire-and-forget health/metric writes.

**Call sites (per route, both the anthropic-upstream and openai-upstream branches):**
- `recordAuthFailure(...)` at the 4xx-return branch (only fires for 401/403).
- `clearAuthFailure(account.id)` on the 2xx success path (next to / after `emitUsageLog`).

Routes: `apps/gateway/src/routes/messages.ts`, `chatCompletions.ts`, `responses.ts`, `codexResponses.ts` (codex inherits the responses handler). Type-class restriction: only meaningful for `credential.type === "api_key"` attempts (oauth has its own path) — guard the call on the credential/account type so an oauth 401 doesn't enter this counter.

### Counter lifecycle ("consecutive since last success")
- `INCR gw:authfail:<id>` on each 401/403; safety `EXPIRE` (e.g. 24h) refreshed each failure so a silent account's key is eventually reclaimed.
- First crossing of N → degrade (DB write above). The counter is **not** deleted on degrade, so a post-backoff retry that 401s again (counter still ≥ N) re-degrades on a single failure (bounded churn) rather than needing N fresh failures.
- Any 2xx → `DEL` counter + recover the account (clear degraded state) — the auto-heal path for a transient blip or an externally-fixed key.
- Concurrency: multiple concurrent 401s may each see `n >= N` and each issue the degrade update — the update is idempotent (sets the same fields), so that's safe.

## Recovery via rotation (#203 reset)

`apps/api/src/trpc/routers/accounts.ts` `rotate` mutation (~545-630) currently re-seals the credential into `credential_vault` but **does not reset health** (unlike `reonboard` ~646-742 which resets status/schedulable/temp fields). This feature **extends `accounts.rotate`** so that after re-sealing it also clears credential-degradation:
- DB: `status='active'`, `tempUnschedulableUntil=null`, `tempUnschedulableReason=null` (only when the existing reason is `api_key_invalid_credential` — don't stomp an unrelated pause), `errorMessage=null`.
- Redis: `DEL gw:authfail:<id>` (so a freshly-rotated key starts clean). The api/trpc layer has Redis access in ctx; if not cleanly available, the gateway's next 2xx will DEL it anyway — the DB recovery is the essential part.

The member self-service `rotateOwn` (~348-428) gets the same reset (mirror), so BYOK members recover their own upstream by rotating.

## Surfacing (UI + metrics)

**Status derivation** — `apps/web/src/components/accounts/status.tsx` `deriveAccountStatus`: add a distinct state **`credential_invalid`** returned when `tempUnschedulableReason === 'api_key_invalid_credential'`, ranked above the generic `paused`/`error` so the `StatusBadge` reads "Credential rejected — rotate" instead of a benign "paused". `tempUnschedulableReason` is already in the `accounts.list` / `accounts.listOwn` tRPC output (SELECT \* projection), so no API change.

**Org admin banner** — `apps/web/src/components/accounts/AccountList.tsx`: mirror the existing `oauth_invalid_grant` amber banner (lines ~241-286), filtering `tempUnschedulableReason === 'api_key_invalid_credential'`, with copy "This API key was rejected by the upstream provider — rotate it." and a button that opens the **`RotateCredentialDialog`** shipped in #203.

**Member status page** — `apps/web/src/components/status/CredentialHealthSection.tsx` already renders `deriveAccountStatus` over the member's own upstreams; the new `credential_invalid` badge surfaces there automatically. Add a deep-link/CTA to the member rotate flow (`/dashboard/upstreams`, `UpstreamRotateDialog`).

**Metrics** — `apps/gateway/src/plugins/metrics.ts`:
- `gw_upstream_auth_failed_total{platform}` — every observed 401/403 from an api_key upstream.
- `gw_upstream_credential_degraded_total{platform}` — incremented once when an account crosses the threshold and is paused (the alertable "a BYOK credential just went dead" signal; analog of `gw_oauth_refresh_dead_total`).

## Configuration

- `GATEWAY_UPSTREAM_AUTH_MAX_FAIL` — consecutive 401/403 before degrade. Default **3**. (Named to avoid the existing client-side per-IP `GATEWAY_AUTH_FAIL_*` throttle knobs.)
- `GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC` — pause window after degrade. Default **3600**.
- Wired into `packages/config/src/env.ts` + `docker/docker-compose.yml` x-app-env + `.env.example`, mirroring the existing `GATEWAY_OAUTH_MAX_FAIL` pattern.

## Scheduler interaction (no code change)

The scheduler's `buildSchedulablePredicates` (`apps/gateway/src/runtime/scheduler.ts:489-506`) already filters `status='active'` AND `tempUnschedulableUntil IS NULL OR < now`. Setting `status='error'` + `tempUnschedulableUntil=now+backoff` makes the degraded account drop out of candidates automatically and re-enter after the window. No scheduler change needed.

## Edge cases

- **One-off 401** (transient upstream auth blip) → counter increments but stays < N → no degrade; a subsequent 2xx resets it. (The threshold is the guard.)
- **Genuinely dead key** → N consecutive 401s → degrade for `backoff` → retry → 401 → re-degrade (counter persisted) → … until rotated. Client-facing failures are bounded to ≈N per backoff window, not unbounded.
- **Rotation while degraded** → `accounts.rotate` clears state + counter → account live on next schedule.
- **Mixed pool** → only the dead account degrades; healthy pool accounts keep serving (the whole point).
- **oauth 401** → guarded out of this counter (oauth has its own `invalid_grant` path); no double-handling.
- **Redis unavailable** → `recordAuthFailure`/`clearAuthFailure` swallow the error; worst case is no degradation (current behavior) — never a broken response.

## Testing

- **Unit** (`upstreamAuthHealth`): only 401/403 count (400/404 no-op); INCR→threshold→DB degrade fields correct; 2xx clears counter + recovers a degraded account; oauth-type guarded out; Redis/DB error swallowed (no throw).
- **Unit** (`deriveAccountStatus`): `api_key_invalid_credential` → `credential_invalid` badge, precedence correct.
- **Unit/integration** (`accounts.rotate` / `rotateOwn`): rotating a credential-degraded account resets status/temp fields (+ counter) so it recovers; does not stomp an unrelated pause.
- **Integration** (route + testcontainer + fake upstream): a fake upstream that 401s for a given account → after N requests the account is `tempUnschedulableReason='api_key_invalid_credential'` + scheduler skips it + the metric incremented; a later fake-200 (or a rotate) recovers it; other 4xx (e.g. 400) does NOT degrade.
- **Config**: the two new knobs parse with defaults.

**Zero schema / migration.**

## Files

**New:** `apps/gateway/src/runtime/upstreamAuthHealth.ts` (+ test).
**Modified:** the 4 routes (call sites), `apps/api/src/trpc/routers/accounts.ts` (`rotate` + `rotateOwn` health reset), `apps/gateway/src/plugins/metrics.ts` (2 counters), `packages/config/src/env.ts` (2 knobs) + `docker/` wiring, `apps/web/src/components/accounts/status.tsx` (`credential_invalid`), `apps/web/src/components/accounts/AccountList.tsx` (banner), `apps/web/src/components/status/CredentialHealthSection.tsx` (CTA), i18n catalogs (banner/badge strings, 5 locales).
