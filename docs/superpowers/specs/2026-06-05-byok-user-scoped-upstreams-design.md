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

1. **Data model** — `upstream_accounts.user_id` (ownership) + `api_keys.routing_policy` (candidate-set policy), plus schema-level CHECK guards (§1.4).
2. **Self-service API surface** — non-admin tRPC mutations to register/list/update/delete *own*
   upstreams, plus a `routingPolicy` param on `apiKeys.issueOwn`, gated by ownership RBAC.
3. **Scheduler routing** — a groupless, surface-derived platform context for non-pool keys (§3.1),
   and `listSchedulableCandidates` (+ the forced/probe and sticky paths) branch on `routing_policy`,
   enforcing the isolation invariants of §1.3 on **every** selection path.

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
3. **The ownership predicate is applied on EVERY account-selection path, not only the candidate
   query.** The scheduler resolves an account through several paths besides
   `listSchedulableCandidates` — the **forced / probe** path (`probeAccount` /
   `loadSchedulableAccount`, which loads a caller-named account) and the **sticky** layers
   (`getRespSticky` / `getSessionSticky`). A stale sticky entry or a future forced path could
   otherwise return an account that violates invariant 1 or 2. Therefore every path that yields an
   `accountId` must **re-validate** it against the request's policy predicate before use:
   `pool` ⇒ the resolved account must satisfy `user_id IS NULL`; `own` ⇒ `user_id = req.userId`.
   (Sticky layers are keyed on `groupId` and so are naturally skipped for `own` keys — which carry
   no group — but the re-validation is still asserted for the `pool`/grouped case so a sticky row
   written before an account became user-owned can never be honoured.)

`routing_policy` and `group_id` are **mutually exclusive**: `own` / `own_then_pool` bypass
group dispatch (groups are a pool concept). This is enforced at **two** layers: the API layer
rejects setting a non-`pool` policy together with a `group_id`, **and** a DB CHECK constraint
backs it (§1.4).

### 1.4 Schema-level anti-drift guards
Belt-and-braces constraints so a bug or a future code path cannot create an unsafe row:

- `api_keys`: `CHECK (routing_policy = 'pool' OR group_id IS NULL)` — a non-pool key can never
  carry a group binding.
- `upstream_accounts`: `CHECK (user_id IS NULL OR team_id IS NULL)` — a row is **user-owned XOR
  team-scoped**, never both (org-pooled = both NULL).
- **Admin surface guard:** `accountGroups.addMember` (the group member-management mutation) must
  **reject** an upstream whose `user_id IS NOT NULL`. Account groups are a pool concept; a BYOK
  credential must never be placed into a pool group by an admin, which would re-expose it to other
  users via the `pool` path.

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
- **`updateOwn` is metadata-only** in P1 — `name`, `schedulable`, `priority`. It does **not**
  rotate the credential.
- **Credential rotation in P1 = delete + re-register** (`deleteOwn` then `registerOwn`). This
  matches the current admin surface, where "輪替憑證" / rotate is itself stubbed ("即將推出"). A
  dedicated `accounts.rotateOwn` (in-place re-encrypt without losing the row/usage history) is
  **deferred** — it pairs naturally with delivering the admin rotate feature (candidate for P3).

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

### 3.1 Platform source for non-pool keys (the groupless routing context)
Today platform is **group-derived**: `groupContextPlugin` (`middleware/groupContext.ts`) resolves
`req.gwGroupContext`, and `resolveGroupContext` (`runtime/groupDispatch.ts`) **synthesizes a legacy
`anthropic` group when `group_id IS NULL`**. Routes and dispatch then read
`req.gwGroupContext!.platform`, and `autoRoute` (`routes/dispatch.ts`) dispatches by that platform.
This is fine for `pool` keys but breaks BYOK: an `own` key carries no group, and the legacy-synth
would wrongly force every such request to `anthropic`.

P1 therefore makes **platform surface-derived for non-pool keys**, via a **new dedicated resolver**
`platformForGatewayRoute(req)` — *not* the usage-log helper. `usageLogInboundPlatformForSurface`
(`runtime/usageLogging.ts:193`) only knows the three usage-writing surfaces and `compact` doesn't
even write a usage row, so it cannot be the routing authority. `platformForGatewayRoute` enumerates
**every** registered gateway route:

| route surface | platform |
|---|---|
| `/v1/messages` | `anthropic` |
| `/v1/chat/completions` | `openai` |
| `/v1/responses` | `openai` |
| `/v1/responses/compact` | `openai` |
| `/backend-api/codex/responses` (Codex alias) | `openai` |

(Only `/v1/messages` is anthropic; the Codex alias and `compact` are OpenAI-only. The resolver is
the single source of truth and must be updated whenever a route is added.)

- `groupContextPlugin` / `resolveGroupContext` must **not** synthesize the legacy group for a
  non-pool key. Instead it produces a **groupless routing context** carrying
  `{ policy, userId, platform: platformForGatewayRoute(req) }` (and no `groupId`). For `pool` keys
  the existing group resolution (including the legacy-anthropic synth for null group) is
  **unchanged**.
- The `req.gwGroupContext!.platform` reads in `messages.ts` / `chatCompletions.ts` /
  `responses.ts` / `codexResponses.ts` and the `autoRoute` wrap must handle the groupless case by
  reading platform from this context (surface-derived) rather than asserting a group is present.

**Touch-points:** new `platformForGatewayRoute` (likely in `routes/dispatch.ts` or a small
`routes/surfacePlatform.ts`), `middleware/groupContext.ts`, `runtime/groupDispatch.ts`,
`routes/dispatch.ts` (`autoRoute`), and the `req.gwGroupContext` reads in
`routes/{messages,chatCompletions,responses,codexResponses}.ts`.

### 3.2 Candidate selection
`apps/gateway/src/runtime/scheduler.ts` `listSchedulableCandidates` branches on
`req.routingPolicy` (layered on the existing org_id + platform + schedulable + not-rate-limited
/ not-overloaded base conditions):

| policy | added WHERE |
|---|---|
| `pool` | `user_id IS NULL` + existing group/team logic (**only change: the extra `user_id IS NULL`**) |
| `own` | `user_id = req.userId` (ignores `group_id`; platform from §3.1; picks the caller's upstream for the request platform) |
| `own_then_pool` | run the `own` query; only if it returns empty, run the **ungrouped org/team pool** query defined in §4.3 |

`own` / `own_then_pool` bypass `groupDispatch` (group is a pool concept). Per invariant §1.3.3, the
**forced/probe** path and any **sticky** hit re-validate the resolved account against the policy
predicate (`pool` ⇒ `user_id IS NULL`; `own` ⇒ `user_id = req.userId`) before use — the ownership
filter is not confined to the candidate query.

## 4. Error Handling

### 4.1 "No upstream" must distinguish *not-registered* from *temporarily-unschedulable*
The candidate query (§3.2) applies `schedulable = true` + `status = 'active'` + not-rate-limited +
not-overloaded + not-temp-unschedulable filters **before** the set is empty-tested. So emptiness of
the *filtered candidate set* does **not** mean "no credential" — the user may own an upstream that
is merely paused / rate-limited / overloaded. The `409` must therefore key off a **separate,
unfiltered existence check**, not the candidate-set emptiness:

For an `own` request, resolve in two steps:
1. **Existence:** is there ≥1 **non-deleted** own row (`user_id = req.userId`, matching the surface
   platform, `deleted_at IS NULL`) — *ignoring* schedulability filters?
   - **No** → `409 no_own_upstream` ("No credential registered for <platform> — add one in
     settings"). **Not 503.**
2. **Schedulability:** a row exists but the *filtered* candidate set is empty (paused / rate-limited
   / overloaded / temp-unschedulable / expired) → the **existing transient / health error** (the
   current no-schedulable-account path, typically 503), **not** `409 no_own_upstream`. Surfaced as
   a credential-health signal in **P3**.

### 4.2 Per-policy semantics
- **`own`** → §4.1 (409 only when no non-deleted own row exists).
- **`own_then_pool`** with no own row → **falls back to the pool** (§4.3); does *not* return
  `no_own_upstream`. Surfaces an error only when **both** own and pool yield nothing, using the
  **existing pool error semantics** — never `409 no_own_upstream`.
- **`pool`** with no pool upstream → unchanged existing behaviour.
- Any policy where an upstream exists but the upstream **rejects the credential** (401) → existing
  `all_upstreams_failed` 503 path (consistent with the 2026-06-05 live smoke); surfaced as a
  credential-health signal in **P3**.

### 4.3 `own_then_pool` fallback scope (pinned, no ambiguity)
A non-pool key carries **no `group_id`** (mutual exclusion, §1.3/§1.4), so the fallback cannot
target any *named* group. P1 defines the fallback pool explicitly as the **ungrouped org/team
pool**: candidates with `org_id = req.orgId` **AND** the existing `teamPredicate(req.teamId)`
(team-scoped beats org-level) **AND** `platform = <surface platform>` **AND** `user_id IS NULL`
**AND not bound through `account_group_members`** — i.e. exactly the candidate set a `pool` key with
a NULL `group_id` resolves today (the legacy org/team path), minus any user-owned rows. (A future
explicit `fallback_group_id` on the key is noted as a possible enhancement but is **out of P1**.)

### 4.4 Registration input validation (no probe in P1)
`registerOwn` does **not** probe the provider (probe is P3), and the credential is an opaque string.
So input validation only rejects **empty / oversized / non-string** credentials. A **well-formed but
provider-invalid** key **is stored** and later surfaces as a credential-health signal / upstream
failure (P3) — it is *not* caught at registration time.

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
  2. user A's `own` request never returns user B's upstream;
  3. the **forced/probe** path re-validates ownership (a forced account that violates the policy
     predicate is rejected, not honoured);
  4. a **stale sticky** entry resolving to a now-user-owned account is rejected on the `pool` path.
- **Platform-from-surface (§3.1):** an `own` key with no group routes `/v1/messages` to the
  caller's `anthropic` upstream and `/v1/chat/completions` to the caller's `openai` upstream — i.e.
  the legacy-anthropic synth does NOT apply to non-pool keys.
- **Schema guards (§1.4):** DB rejects `api_keys` with non-`pool` policy + non-null `group_id`;
  rejects `upstream_accounts` with both `user_id` and `team_id` set; `accountGroups.addMember`
  rejects an upstream whose `user_id IS NOT NULL`.
- **Error semantics (§4):**
  - `own` with **no non-deleted own row** → `409 no_own_upstream`;
  - `own` **with** an own row that is paused / rate-limited / overloaded / temp-unschedulable →
    the existing **transient/503** path, **not** `409` (the §4.1 existence-vs-schedulability split);
  - `own_then_pool` with no own row but an available pool upstream → served by pool (no 409);
  - `own_then_pool` fallback resolves to the **ungrouped org/team pool** (§4.3), never a named group.
- **Surface→platform (§3.1):** `platformForGatewayRoute` returns `anthropic` for `/v1/messages` and
  `openai` for `/v1/chat/completions`, `/v1/responses`, `/v1/responses/compact`, and
  `/backend-api/codex/responses` (Codex alias + compact included).
- **Registration validation (§4.4):** empty / oversized / non-string credential rejected; a
  well-formed but provider-invalid key is **stored** (no probe in P1).
- **Integration (testcontainer pg):** `registerOwn` → `issueOwn(routingPolicy:"own")` → call
  gateway → request is served by the caller's own upstream; `usage_logs.account_id` = that
  upstream and `user_id` = caller.
- **RBAC:** a non-admin can `registerOwn` but `listOwn` shows only their own; cannot
  update/delete another user's upstream; cannot set `group_id` together with a non-`pool` policy;
  `updateOwn` cannot mutate the credential (metadata-only).

## Open Questions / Risks

- **Migration drift:** prior migrations (0016/0017) hit a drizzle journal-`when` vs `Date.now()`
  skip bug requiring out-of-band psql apply. This change is a deploy that runs a new migration —
  follow the established trim-snapshot + verify-applied-on-prod procedure.
- **`own_then_pool` cost attribution:** when a BYOK user falls back to the shared pool, the request
  is billed against the operator's pooled credential. That's intended, but worth a usage-log marker
  (the existing `account_id` already distinguishes which upstream served it, so no schema change —
  just be explicit in any P3 reporting).
- **Multi-org caller:** `registerOwn` assumes a single primary org (same caveat as `issueOwn`).
