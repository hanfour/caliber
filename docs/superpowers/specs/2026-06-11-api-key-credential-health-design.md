# api_key Upstream Credential Health — Design

**Date:** 2026-06-11 (revised 2026-06-12 after Claude+codex cross-review)
**Status:** Approved (brainstorming + multi-model spec review folded in) — ready for plan
**Issue:** #205 (launch-prep)
**Scope:** Caliber gateway — detect a dead/rejected **api_key** upstream credential, degrade its health (recoverably) so the scheduler stops routing to it, and surface it for rotation.

## Problem

When an `api_key` upstream's stored credential is invalid (revoked / wrong / expired), the upstream returns **401** (`authentication_error` / `invalid x-api-key`). Observed in prod 2026-06-11: a pool `anthropic api_key` returned 401 yet stayed `status='active', schedulable=true` and kept being scheduled — every request that landed on it failed, with no signal to rotate.

**Two confirmed, related code facts (verified by Claude + codex, file:line):**

1. **Inconsistent 401 handling across surfaces.** Only the `/v1/messages` **Anthropic non-stream** branch *returns* a 4xx (`messages.ts:459/463`) — so its 401 never reaches the failover loop, never degrades. **Every other path throws** 401 into the failover loop (chat non-stream `chatCompletions.ts:321`, responses non-stream `responses.ts:481`, messages→openai `messages.ts:1177`, all streaming paths `messages.ts:769` / `chatCompletions.ts:586` / `responses.ts:837` / `responses.ts:1338`, and `/v1/responses/compact` `responses.ts:670`).

2. **The thrown path degrades, but un-recoverably.** A thrown 401/403 is classified `auth_invalid` (`classifier.ts:18`) → the loop applies `stateUpdate: { status: 'error' }` (`failoverLoop.ts:292`). But **nothing ever resets `status='error'` back to `active`** (no `status:"active"` write exists anywhere in `apps/gateway/src/runtime`), and the scheduler requires `status='active'` (`scheduler.ts:493`). So a single 401 on a thrown path **permanently disables the account** — a pre-existing latent bug.

So today: the prod `/v1/messages` non-stream path **never** degrades a dead key; every other path degrades on the **first** 401 and **never recovers**. Neither is right.

## Goal & Non-Goals

**Goal:** Any `api_key` upstream that the provider rejects with **401** is, after **N consecutive** failures, **temporarily** paused (recoverably) so the scheduler skips it; it **auto-recovers** on a later success or on credential **rotation**; and it is **surfaced** to operator/member with a "rotate this credential" affordance. One coherent mechanism across all surfaces. Observable via metrics. This also **fixes the latent un-recoverable `status='error'` bug** above.

**Non-Goals:**
- NOT counting **403** (entitlement / model-policy / project 403s are not a dead key — `codex` flag). 403 still fails over but does not degrade; a finer 401-vs-403 taxonomy is a future refinement.
- NOT the **OAuth** path — oauth has its own `invalid_grant`/`refresh_exhausted` degradation + re-onboard (`oauthRefresh.ts:538-615`). This is the api_key analog; oauth request-time 401s are out of scope here.
- NOT changing the in-request **failover decision** beyond the one alignment below (the prod non-stream path starts failing over on 401, like every other path already does).
- NO schema change / migration (counter in Redis; degraded state reuses existing `upstream_accounts` columns).

## Decisions (brainstorm + Claude+codex review)

| # | Decision |
|---|----------|
| Trigger | **Threshold:** degrade after **N consecutive 401s**, `GATEWAY_UPSTREAM_AUTH_MAX_FAIL` default **3**. Reset on any 2xx. |
| Signal | **401 only.** 403 fails over but is not a credential-death signal. |
| Counter store | **Redis** `gw:authfail:<accountId>` — zero migration; `INCR` per 401, `DEL` on 2xx; generous safety TTL. |
| Degraded state | **`tempUnschedulableUntil = now + backoff` + `tempUnschedulableReason='api_key_invalid_credential'` + sanitized `errorMessage`. DO NOT touch `status`.** (codex's fatal-bug fix: `status='error'` would survive the backoff window and the `status='active'` predicate would keep the account out forever — recovery must rely on the temp predicate alone, which re-admits automatically when `tempUnschedulableUntil < now`.) |
| Recovery | **Timed backoff** (`GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC` default **3600**) → scheduler auto-retries when the temp window expires; a 2xx clears it, a repeat 401 re-arms it (bounded churn). **Rotation (`accounts.rotate`/`rotateOwn`) clears it immediately.** |
| Placement | **Centralized in the failover loop**, not scattered across route call sites (see below). |
| errorMessage | **Generic sanitized** string (e.g. `"upstream rejected credential (401)"`), never the provider response body (leak risk — `codex`; mirrors `oauthRefresh.ts:547` sanitize vs the raw-body copy at `upstreamErrorMapping.ts:48`). |

## Architecture — centralized in the failover loop

The failover loop already has the two choke points we need:
- **Success:** `scheduler.reportResult(account.id, true)` on a successful attempt return (`failoverLoop.ts:245`). Streaming attempts also return normally on completion, so this covers **all** 2xx (stream + non-stream).
- **Failure:** the `catch` → `classifyUpstreamError` (`failoverLoop.ts:~250`). 401/403 classify as `auth_invalid`.

New module **`apps/gateway/src/runtime/upstreamAuthHealth.ts`** (best-effort, never throws into the request path — swallow Redis/DB errors):

```
recordAuthFailure(deps, account, status) -> Promise<void>
  if status !== 401: return                      // 403 etc. → failover only, no degrade
  if account.type !== "api_key": return          // oauth handled by its own path
  if await redis.exists(`gw:authgrace:${account.id}`): return   // just-rotated grace window (race guard)
  const n = await redis.incr(`gw:authfail:${account.id}`); refresh safety TTL
  metrics.upstreamAuthFailedTotal.inc({ platform: account.platform })
  if n >= GATEWAY_UPSTREAM_AUTH_MAX_FAIL:
    // CONDITIONAL write — only the healthy→degraded transition flips it
    const rows = await db.update(upstreamAccounts).set({
      tempUnschedulableUntil: now + GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC,
      tempUnschedulableReason: "api_key_invalid_credential",
      errorMessage: "upstream rejected credential (401)",   // sanitized, generic
    }).where(and(
      eq(id, account.id),
      // re-arm if not already in this state OR the window already lapsed
      or(ne(tempUnschedulableReason,"api_key_invalid_credential"), lt(tempUnschedulableUntil, now)),
    )).returning({ id })
    if (rows.length === 1) metrics.upstreamCredentialDegradedTotal.inc({ platform })  // count TRANSITIONS only

clearAuthFailure(deps, account) -> Promise<void>
  await redis.del(`gw:authfail:${account.id}`)
  // self-heal: recover an account degraded for *this* reason (anti-stomp: don't clear oauth/rate-limit pauses)
  await db.update(upstreamAccounts).set({
    tempUnschedulableUntil: null, tempUnschedulableReason: null, errorMessage: null,
  }).where(and(eq(id, account.id), eq(tempUnschedulableReason, "api_key_invalid_credential")))
```

**Loop wiring (`failoverLoop.ts`):**
- After a successful attempt return (~245) → `await clearAuthFailure(deps, account)`.
- In the `catch`, when `action.reason === 'auth_invalid'` → `await recordAuthFailure(deps, account, upstreamErr.status)` **instead of** applying the classifier's `status='error'` stateUpdate. Failover still proceeds (`switch_account`).

**Classifier reconciliation (`classifier.ts:18-23`):** drop the `stateUpdate: { status: 'error' }` from the 401/403 branch (keep `kind: switch_account, reason: 'auth_invalid'`). Auth health is now owned by `recordAuthFailure`; the un-recoverable `status='error'` single-strike is removed for all paths. (403 → fails over, no state change — intentional; was previously a one-strike disable.)

**The one route change (`messages.ts` Anthropic non-stream, ~459):** make a **401** throw (so it reaches the loop → failover + `recordAuthFailure`) instead of being returned. Other 4xx keep returning directly (client error — unchanged). This aligns the prod path with every other surface.

`codexResponses.ts` wraps `makeResponsesRouteHandler` (no own upstream call) and `/v1/responses/compact` throws non-2xx — both flow through the loop, so the centralized hooks cover them automatically.

## Rotation recovery + race guard

`accounts.rotate` (`accounts.ts:~600`) and `rotateOwn` (`accounts.ts:~387`) currently only re-seal `credential_vault`. Extend both (Redis is available in ctx — `context.ts:51`, prefix `caliber:gw:`):
- Clear the degraded state **only when** `tempUnschedulableReason='api_key_invalid_credential'` (anti-stomp): set `tempUnschedulableUntil/reason/errorMessage = null`.
- `redis.del("gw:authfail:<id>")` (reset the counter).
- **Race guard (codex D):** set `gw:authgrace:<id>` with a short TTL (e.g. 60s). In-flight requests still using the *old* credential can 401 right after rotate; `recordAuthFailure` honors the grace key and skips degrading during it, so a fresh rotation isn't immediately re-degraded. (Zero-schema; avoids needing a `resolveCredential` generation check.)

## Surfacing (UI + metrics)

- **`deriveAccountStatus`** (`status.tsx`): add `credential_invalid` to the union (`:8`), add `tempUnschedulableReason` to the input (`:29`), and rank it **above** the generic `paused` (`:60`) so the badge reads "Credential rejected — rotate" rather than a benign "paused". `tempUnschedulableReason` is already in `accounts.list`/`listOwn` output (`accounts.ts:49/265`).
- **Org `AccountList`**: mirror the oauth_invalid_grant amber banner (`AccountList.tsx:241-286`), filtering `tempUnschedulableReason === 'api_key_invalid_credential'`, copy "This API key was rejected by the upstream — rotate it.", button opens the **`RotateCredentialDialog`** (shipped #203).
- **Member status page `CredentialHealthSection`**: surfaces the new badge automatically via `deriveAccountStatus`; add a CTA to the member rotate flow (`/dashboard/upstreams`).
- **Metrics** (`plugins/metrics.ts`): `gw_upstream_auth_failed_total{platform}` (every 401) + `gw_upstream_credential_degraded_total{platform}` (incremented **only on the healthy→degraded DB transition** — the alertable "a BYOK credential went dead" signal).

## Configuration

- `GATEWAY_UPSTREAM_AUTH_MAX_FAIL` (default **3**) and `GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC` (default **3600**) — distinct names so they don't collide with the existing client-side per-IP `GATEWAY_AUTH_FAIL_*` throttle. Wired into `packages/config/src/env.ts` + `docker/` x-app-env + `.env.example`, mirroring `GATEWAY_OAUTH_MAX_FAIL`.

## Scheduler interaction (no scheduler change)

`buildSchedulablePredicates` (`scheduler.ts:489-506`) already filters `tempUnschedulableUntil IS NULL OR < now` — setting only the temp fields drops the account during the window and **re-admits it automatically** when the window lapses. Because we no longer set `status='error'`, recovery works with zero scheduler change. (This is the crux of codex's fatal-bug fix.)

## Edge cases

- One-off 401 → counter < N → no degrade; next 2xx resets. The threshold is the guard.
- Dead key → N×401 → pause `backoff` → retry → 401 → re-degrade (counter persisted) → … until rotated. Client-facing failures bounded ≈N per window.
- Rotation while degraded → state + counter cleared + grace window → live on next schedule, not immediately re-degraded by stale in-flight 401s.
- Mixed pool → only the dead account degrades; healthy accounts keep serving.
- oauth 401 → guarded out (`account.type` check); oauth has its own path.
- 403 → fails over, does not degrade (avoids false-degrade on permission/model 403s).
- Redis/DB error in the helper → swallowed; worst case = no degradation (today's behavior), never a broken response.
- Concurrency → the degrade UPDATE is conditional + `.returning()`; only the single row-flipping request increments the degraded metric.

## Testing

- **Unit (`upstreamAuthHealth`):** only 401 + only `type='api_key'` count (403 / oauth / non-401 no-op); INCR→threshold→conditional degrade writes the right temp fields and a sanitized errorMessage (never body text); 2xx clears counter + recovers a degraded account; grace key suppresses degrade; Redis/DB error swallowed (no throw); degraded metric fires once per transition under concurrent calls.
- **Unit (`classifier`):** 401/403 → `switch_account`/`auth_invalid` with **no** `status` stateUpdate (regression guard for the removed single-strike).
- **Unit (`deriveAccountStatus`):** `api_key_invalid_credential` → `credential_invalid`, precedence above `paused`.
- **Integration (`accounts.rotate`/`rotateOwn`):** rotating a credential-degraded account clears temp fields + counter + sets grace; does not stomp an unrelated (oauth/rate-limit) pause.
- **Integration (route + testcontainer + fake upstream):** fake upstream 401s for one account → after N requests it's `tempUnschedulableReason='api_key_invalid_credential'`, scheduler skips it, degraded metric +1; after the backoff window a fake-200 (or a rotate) recovers it; a 400 does NOT degrade; the messages-anthropic-non-stream 401 now reaches the loop (degrades) while other 4xx still return to the client.
- **Config:** the two knobs parse with defaults.

**Zero schema / migration.**

## Files

**New:** `apps/gateway/src/runtime/upstreamAuthHealth.ts` (+ test).
**Modified:** `apps/gateway/src/runtime/failoverLoop.ts` (success + auth_invalid hooks), `packages/gateway-core/src/stateMachine/classifier.ts` (drop 401/403 `status='error'`), `apps/gateway/src/routes/messages.ts` (anthropic non-stream 401 → throw), `apps/api/src/trpc/routers/accounts.ts` (`rotate` + `rotateOwn` health reset + grace key), `apps/gateway/src/plugins/metrics.ts` (2 counters), `packages/config/src/env.ts` (2 knobs) + `docker/` wiring, `apps/web/src/components/accounts/status.tsx` (`credential_invalid`), `AccountList.tsx` (banner), `apps/web/src/components/status/CredentialHealthSection.tsx` (CTA), i18n catalogs (banner/badge strings, 5 locales).
