# BYOK P1 — User-Scoped Upstreams + Routing Isolation + Self-Service API-Key Registration

**Date:** 2026-06-05
**Status:** Design (approved for spec) — pending writing-plans
**Scope:** P1 of the 4-part BYOK ("bring your own key") initiative.

## Background & Motivation

Today Caliber runs a **centralised credential pool**: the operator registers org/team-scoped
upstream accounts (OpenAI / Anthropic api-key or OAuth), and every user's request is routed
through the gateway onto that shared pool. Users reach the gateway over VPN.

The operator wants to shift toward **BYOK**: each end user registers their *own* upstream
credential, and the operator's gateway stays in the request path purely to **proxy and meter**
(usage + status), without the operator having to own/fund the upstream credentials.

This document specifies **P1**, the foundation that the rest of BYOK builds on. The full BYOK
vision was decomposed into four independent sub-projects:

| # | Sub-project | Depends on |
|---|---|---|
| **P1** (this doc) | User-scoped upstreams + routing isolation + **API-key** self-service registration | — (foundation) |
| P2 | Hosted self-service **OAuth** login flow (PKCE → vault) | P1 |
| P3 | Status / health dashboard (credential health/expiry, rate/quota/error, live activity) | P1 |
| P4 | Connectivity / access model (VPN vs public per-user auth gateway) | mostly independent |

### Decisions captured during brainstorming
- **Request path:** requests still flow through the gateway as a proxy; users register their key *into* Caliber. The operator can fully meter (and does see the key + traffic).
- **Isolation unit:** both **per-user** and **per-team**. Team-scope already exists (`upstream_accounts.team_id`); P1 adds the **per-user** scope. Team self-service is out of P1 (team upstreams continue via the existing admin `accounts.create`).
- **Credential types:** API key and OAuth both wanted overall, but **P1 ships API-key self-service only**; OAuth self-service is P2.
- **Architecture:** **Approach C** — `userId` ownership column + scheduler ownership filter **+ a per-api-key routing-policy knob** (own-only vs own-then-pool vs pool).
- **Credential probe** at registration time is deferred to **P3**.

## Non-Goals (P1)

- Hosted OAuth self-service (P2).
- Credential health probing, expiry surfacing, status dashboard (P3).
- Connectivity / VPN-vs-public changes (P4).
- Team-member self-registration of *team-shared* upstreams (continues via admin `accounts.create`).
- Multi-org users: `registerOwn` uses the caller's single primary org, mirroring the existing
  `apiKeys.issueOwn` limitation; multi-org is out of scope and tracked with the same caveat.

## Architecture Overview

Three cohesive changes, all backward-compatible (existing keys/upstreams behave exactly as today):

1. **Data model** — `upstream_accounts.user_id` (ownership) + `api_keys.routing_policy` (candidate-set policy).
2. **Self-service API surface** — non-admin tRPC mutations to register/list/update/delete *own*
   upstreams, plus a `routingPolicy` param on `apiKeys.issueOwn`, gated by ownership RBAC.
3. **Scheduler routing** — `listSchedulableCandidates` branches on `routing_policy`, enforcing two
   isolation invariants.

## 1. Data Model

### 1.1 `upstream_accounts.user_id`
Add **nullable** `user_id uuid` FK → `users.id` (`ON DELETE` matches existing account FKs; cascade
or restrict per the prevailing convention in `packages/db/src/schema/accounts.ts`).

- `NULL` ⇒ org/team-pooled upstream — **exactly today's behaviour**.
- non-NULL ⇒ a user-owned BYOK upstream.
- `org_id` is still always set (a user-owned upstream lives in the caller's org); `team_id` stays
  NULL for user-owned upstreams.

New partial index to keep BYOK selection fast:
```
CREATE INDEX upstream_accounts_user_select_idx
  ON upstream_accounts (org_id, user_id, platform, priority)
  WHERE deleted_at IS NULL AND schedulable = true;
```

Migration: additive only (new nullable column + index). No backfill — existing rows get
`user_id = NULL` and remain pooled. Trim the drizzle snapshot the same way prior migrations did
(watch the journal-`when` drift noted in earlier migrations).

### 1.2 `api_keys.routing_policy`
Add `routing_policy` enum, default **`pool`**:

| value | candidate upstreams (layered on the existing org_id + platform + schedulable + not-rate-limited filters) |
|---|---|
| `pool` (default = today) | org/team/group pool **excluding all `user_id IS NOT NULL`** rows |
| `own` | only `user_id = api_key.user_id`; if none for the request's platform → clean 4xx (not 503) |
| `own_then_pool` | `own` candidates first; empty set ⇒ fall back to the `pool` query |

`routing_policy` is selected per **api_key**, not per user: a user may hold both a personal
`own` key and a `pool` key. Default `pool` makes every existing key behave identically to today.

### 1.3 Isolation invariants (the security core)
1. **A pool request never schedules any user-owned upstream.** The `pool` path *must* add
   `user_id IS NULL`. Without it, user A's private credential could serve user B — the single most
   dangerous leak. This filter closes it.
2. **An `own` request only schedules the caller's own upstreams** (`user_id = api_key.user_id`),
   across both platforms from a single key.

`routing_policy` and `group_id` are **mutually exclusive**: `own` / `own_then_pool` bypass
group dispatch (groups are a pool concept). The API layer rejects setting a non-`pool` policy and a
`group_id` on the same key.

## 2. Self-Service API Surface (apps/api tRPC)

### 2.1 `accounts.registerOwn`
- **Permission:** new RBAC action `account.register_own` — **authenticated member, no admin role**
  (mirrors `api_key.issue_own`'s no-role-check pattern).
- **Input:** `{ name, platform: "openai"|"anthropic", type: "api_key", credentials: string }`
  (`type` fixed to `api_key` in P1; OAuth is P2).
- **Forced server-side:** `userId = caller.id`, `orgId = caller's primary org`, `teamId = null`.
- **Storage:** reuses the existing `buildCredentialPlaintext` + AES-256-GCM/HKDF
  `credential_vault` path unchanged (`apps/api/src/trpc/routers/accounts.ts`,
  `packages/gateway-core/src/crypto/aesGcmHkdf.ts`).
- Credential **probe is deferred to P3** — P1 stores without blocking.

### 2.2 `accounts.listOwn` / `accounts.updateOwn` / `accounts.deleteOwn`
- Operate strictly on rows where `user_id = caller.id` (ownership-scoped RBAC action
  `account.manage_own`). A non-admin manages only their own upstreams.

### 2.3 `apiKeys.issueOwn` — add `routingPolicy`
- New optional param `routingPolicy: "pool" | "own" | "own_then_pool"` (default `pool`).
- Validation: if `routingPolicy !== "pool"` then `groupId` must be absent (mutual exclusion, §1.3).

### 2.4 RBAC boundary
- Every new action authorises on `userId === caller.id` — users touch only their own resources.
- `super_admin` / `org_admin` keep full-org visibility via the existing admin surfaces (so the
  operator can collect data & status across all BYOK upstreams).
- The existing admin-only `accounts.create` (org/team-scope, `user_id = NULL`) is **unchanged** —
  team-shared upstreams continue through it.

**File touch-points:** `apps/api/src/trpc/routers/accounts.ts` (registerOwn/listOwn/updateOwn/
deleteOwn), `apps/api/src/trpc/routers/apiKeys.ts` (issueOwn + routingPolicy),
`packages/auth/src/rbac/actions.ts` (`account.register_own`, `account.manage_own`),
`packages/auth/src/rbac/check.ts` (ownership checks).

## 3. Scheduler Routing (apps/gateway)

`apps/gateway/src/middleware/apiKeyAuth.ts`: select `routing_policy` into `req.apiKey`
(alongside the existing userId/orgId/teamId/groupId).

`apps/gateway/src/runtime/scheduler.ts` `listSchedulableCandidates` branches on
`req.routingPolicy` (layered on the existing org_id + platform + schedulable + not-rate-limited
/ not-overloaded base conditions):

| policy | added WHERE |
|---|---|
| `pool` | `user_id IS NULL` + existing group/team logic (**only change: the extra `user_id IS NULL`**) |
| `own` | `user_id = req.userId` (ignores `group_id`; picks the caller's upstream for the request platform) |
| `own_then_pool` | run the `own` query; only if it returns empty, run the `pool` query |

`own` / `own_then_pool` bypass `groupDispatch` (group is a pool concept).

## 4. Error Handling

- `own` (or `own_then_pool` after fallback) with **no own upstream for the platform** → clean
  **4xx** (e.g. `409 no_own_upstream`, message: "No credential registered for <platform> — add one
  in settings"). **Not 503** — 503 implies transient and would mislead clients into retrying.
- Own upstream exists but the upstream rejects the credential (401) → existing
  `all_upstreams_failed` 503 path (consistent with the 2026-06-05 live smoke); surfaced as a
  "credential health" signal in **P3**.
- `registerOwn` with malformed credentials → rejected at tRPC input validation.

## 5. Usage / Status Surfacing (P1 minimum)

No new collection work — `usage_logs` already records `userId`, `apiKeyId`, `accountId`, tokens,
cost, model, timestamps, with per-user/key/account time indexes, and `usage.summary` / `usage.list`
already support `own` scope with RBAC. P1 only needs BYOK requests to log correctly
(`account_id` = the caller's own upstream, `user_id` = caller). The dedicated status/health
dashboard is **P3**.

## 6. Testing (vitest + testcontainer, matching existing conventions)

- **Unit (candidate query):** matrix over `pool / own / own_then_pool` × `has-own / no-own` ×
  `openai / anthropic`.
- **Isolation invariants (highest priority), each its own assertion:**
  1. a `pool` request never returns any `user_id IS NOT NULL` candidate;
  2. user A's `own` request never returns user B's upstream.
- **Integration (testcontainer pg):** `registerOwn` → `issueOwn(routingPolicy:"own")` → call
  gateway → request is served by the caller's own upstream; `usage_logs.account_id` = that
  upstream and `user_id` = caller.
- **RBAC:** a non-admin can `registerOwn` but `listOwn` shows only their own; cannot
  update/delete another user's upstream; cannot set `group_id` together with a non-`pool` policy.

## Open Questions / Risks

- **Migration drift:** prior migrations (0016/0017) hit a drizzle journal-`when` vs `Date.now()`
  skip bug requiring out-of-band psql apply. This change is a deploy that runs a new migration —
  follow the established trim-snapshot + verify-applied-on-prod procedure.
- **`own_then_pool` cost attribution:** when a BYOK user falls back to the shared pool, the request
  is billed against the operator's pooled credential. That's intended, but worth a usage-log marker
  (the existing `account_id` already distinguishes which upstream served it, so no schema change —
  just be explicit in any P3 reporting).
- **Multi-org caller:** `registerOwn` assumes a single primary org (same caveat as `issueOwn`).
