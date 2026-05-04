# API Key Migration Plan — pivot from individual-OAuth pool to compliant path

**Status**: Phase 1, Phase 3 #1, Phase 3 #2 (all routes), and
Phase 3 #4 shipped.  Phase 2 deferred.
**Date recorded**: 2026-05-04 (initial), last updated 2026-05-04.
**Supersedes for forward work**: `.claude/plans/2026-05-04-forward-debt-5b-handoff.md`
(5b work itself stays on the abandoned branch — see Phase 0).

## Progress

| Phase | Status | Landed as |
|---|---|---|
| Phase 0 — abandon 5b | 🟡 Branch retained locally; calendar deletion ≈ 2026-05-18 | — |
| Phase 1 — OpenAI api_key onboarding | 🟢 shipped 2026-05-04 | PR #52 (`a19c8f0`) |
| Phase 3 #1 — accountGroups admin CRUD | 🟢 shipped 2026-05-04 | PR #53 (`5685583`) |
| Phase 3 #4-a — credential log redaction | 🟢 shipped 2026-05-04 | PR #55 (`b5ac3ce`) |
| Phase 3 #4-b — per-apiKey RPM rate limit | 🟢 shipped 2026-05-04 | PR #56 (`929feb4`) |
| Phase 3 #2 — response cache (helper + /v1/messages canary) | 🟢 shipped 2026-05-04 | PR #57 (`ed91263`) |
| Phase 3 #2 — response cache (all 4 routes) | 🟢 shipped 2026-05-04 | PR #59 (`de1647e`) |
| Phase 2 — ChatGPT Team/Enterprise admin API | ⚪ deferred (no customer pull yet) | — |
| Anthropic path | ⚪ unchanged (decision A11 stands) | — |

---

## Why this plan exists

The originally-scoped Plan 5A backend assumed `upstream_accounts` could be
populated from individual ChatGPT subscription OAuth tokens (Codex CLI
flow), with multi-tenant `apiKeys` issued to internal users routed through
those upstream accounts via `accountGroups` + `scheduler`.  Combined with
the brainstormed enhancements (#1 multi-account pool aggregation, #3
egress IP / UA rotation, #4 dedup-with-evasion-intent), that direction
required active anti-detection work to remain operational at scale.

Decision: pivot the production path to the licensed alternatives —
**OpenAI org API keys** for the API-driven multi-tenant pattern, and
**ChatGPT Team / Enterprise admin API** where org-managed seats are
required.  The existing 5A scheduler / accountGroups / quotaUsd / route
layer is type-agnostic at the credential level and accepts this pivot
with minimal architectural change.

## Hard scope boundaries (what this plan will NOT do)

These items are out of scope for any phase of this plan, regardless of
how they are framed in future requests.  Recorded here so future
sessions don't re-litigate:

- **Outbound IP rotation / proxy pool / egress diversification when the
  intent is defeating platform identification.**  Static, declared egress
  (firewall whitelisting, audit-friendly SNAT) is fine; pool-with-rotation
  is not.
- **HTTP request-feature obfuscation** (User-Agent rotation,
  Accept-Language rotation, request-pattern jitter to defeat
  fingerprinting).  Functional headers are fine; mimicry is not.
- **Aggregating multiple individual ChatGPT subscriptions** (Plus / Pro /
  personal Team-member) into a pool serving end-users who are not the
  subscription holder.  Each individual subscription used by its own
  holder for their own usage stays compliant; aggregation does not.
- **Caching / dedup / RPS limit / retry-backoff designs whose stated
  goal includes "reduce platform detection" or equivalent.**  Same
  techniques with the goal of "reduce cost" or "protect own quota" are
  fine — the goal frames the line.

These boundaries apply equally to internal-only deployments, dev/staging
environments, and proof-of-concepts.  "Internal use" is not an exception
in OpenAI's individual subscription terms.

## Decisions captured this session (2026-05-04)

1. **No existing prod deployment** of pool-style OAuth — this is a
   pure forward-planning pivot, not a sunset.  No notification / refund
   / migration window chapter is needed.
2. **Payment model**: hybrid.  OpenAI org API keys for general
   multi-tenant API access; ChatGPT Team / Enterprise admin API for
   org-managed seat scenarios.  Each path is implemented as its own
   phase below.
3. **5b branch**: abandon (Phase 0).  Five commits on
   `feat/plan-5a-pr5b-oauth-callback-flow` will not be pushed and will
   not be merged.  Branch retained locally for ~2 weeks for reference,
   then deleted.
4. **Anthropic path**: no change.  Plan 5A decision A11 stands —
   Anthropic OAuth keeps using the legacy `runtime/oauthRefresh.ts`
   refresh path until a future plan revisits it.  This plan does not
   touch Anthropic code.

---

## Phase 0 — abandon 5b branch

**Branch**: `feat/plan-5a-pr5b-oauth-callback-flow`
**Top commit**: `41667ba` (Task 5.6 tRPC mutations)

**Commits that will not land on main**:

| commit | summary |
|---|---|
| `239def9` | Foundation — status const + migration 0012 partial index |
| `b2e3e86` | 5.7 completeOAuthFlow runtime |
| `5fbfb99` | 5.8 probeAccount runtime |
| `45ef088` | 5.5 GET /oauth/callback listener |
| `41667ba` | 5.6 admin tRPC OAuth mutations |

**Action**:

1. Branch stays local, no push.
2. After ~2 weeks (≈ 2026-05-18) confirm no need to revisit, then
   `git branch -D feat/plan-5a-pr5b-oauth-callback-flow`.
3. The cross-app dep `apps/api → @aide/gateway` and the
   `apps/gateway/package.json` `exports["./oauth"]` extension live only
   on the branch — they vanish with branch deletion.

**No-op confirmation**: main is clean (verified 2026-05-04, branch never
pushed, cross-app dep never installed in main's `pnpm-lock.yaml`).

---

## Phase 1 — OpenAI org API key path enablement

**Goal**: make `accounts.create({ platform: "openai", type: "api_key", credentials: "sk-..." })`
the supported and documented onboarding path for OpenAI accounts.

**Why this is small**: the runtime is already there.

- `accounts.create` accepts `type: "api_key" | "oauth"` with credential
  envelope handling.
- `resolveCredential` decrypts and discriminates on `type`.
- `upstreamCallOpenai.buildOpenAIAuthHeaders` handles api_key creds via
  `Authorization: Bearer sk-...`.
- `scheduler` / `accountGroups` / `quotaUsd` are credential-type-agnostic.

**Concrete tasks**:

1. **Schema-level platform widening**
   `apps/api/src/trpc/routers/accounts.ts` — `platformEnum` is currently
   `z.enum(["anthropic"])`.  Extend to `z.enum(["anthropic", "openai"])`.
   Verify nothing downstream assumes Anthropic-only.
2. **Admin UI for OpenAI api_key onboarding**
   `apps/web/src/app/dashboard/organizations/[id]/accounts/new` —
   currently the form supports `platform: "anthropic"` selection.  Add
   `platform: "openai"` option; the credential field still takes a
   plain string (sk-...).
3. **Credential validation on submit**
   Light client-side regex check for `sk-...` shape; server-side calls
   `accounts.create` which already encrypts and stores.  Optionally
   wire a one-shot probe (call `/v1/responses` with the key) to detect
   typos before saving.  Reuse `probeAccount` runtime *would* be
   convenient — but `probeAccount` is on the abandoned 5b branch.
   Decide: re-add a slim version of probe under Phase 1 (no OAuth flow
   coupling), or skip and let the first real request expose typos.
4. **Documentation**
   `docs/admin/openai-account-setup.md` (new) — how an org admin
   obtains an `sk-` from `platform.openai.com`, scopes by project, sets
   spend caps, rotates on schedule.  Link from admin UI's onboarding
   form.
5. **Tests**
   - Unit: `accounts.create` accepts `platform: "openai"` and stores.
   - Integration: end-to-end gateway request with an injected fake
     OpenAI upstream returning 200 — verify routing.

**LOC estimate**: ~400 (mostly UI + docs).
**Dependencies**: none.  Can start immediately.

---

## Phase 2 — ChatGPT Team / Enterprise admin API integration

**Goal**: support the org-managed seat scenario where the customer
already has (or is willing to buy) ChatGPT Team or Enterprise seats and
wants centralized provisioning + billing reconciliation.

**Why this is bigger**: I am not certain of the exact OpenAI admin API
surface.  The phase opens with a research task, not implementation.

**Phase 2.0 — research (1-3 days, doc reading + small spike)**:

Open questions to resolve before designing:

- What is the actual surface of OpenAI's admin / org management API
  today?  At least: invite users, create projects, mint per-project API
  keys, fetch usage data per user/project, audit log access.
- Is the admin API gated to Enterprise only, or also available on Team?
  (Pricing / packaging materially affects this phase's value
  proposition.)
- What identifier model does the admin API expose?  Per-user, per-seat,
  per-project, per-service-account?  This decides whether our
  `upstream_accounts` row maps 1:1 to a seat or to a project.
- Is there a way to mint scoped / time-bounded API keys
  programmatically (reduces blast radius if a key leaks)?
- Are usage data feeds latency-acceptable for our billing
  reconciliation?  (Real-time vs. delayed batch.)

**Phase 2.1 — design (after research)**:

Sketch only — concrete after Phase 2.0:

- Onboarding: org admin links our system to their OpenAI org via an
  admin key.  We store the admin key in `credential_vault` as a
  privileged credential type (`type: "openai_admin"`?).  Strict access
  controls — only the admin-onboarding mutation touches it.
- Seat sync: scheduled job pulls org user list, creates corresponding
  `upstream_accounts` rows.  Per-user / per-seat scoped API keys minted
  via admin API and stored as regular `type: "api_key"` upstream
  accounts pointing back at the seat.
- Billing reconciliation: pull OpenAI usage data, reconcile against
  `usage_logs.actual_cost_usd`.

**LOC estimate**: TBD — depends on Phase 2.0 outcome.  Rough order of
magnitude 800-1500 LOC if the admin API is well-shaped, more if we have
to glue around limitations.

**Dependencies**: Phase 1 done first (so the basic api_key path is
proven before adding admin-API-driven provisioning on top).

---

## Phase 3 — compliant versions of the original brainstorm

The brainstormed enhancements, with their evasion intent removed, map to
legitimate engineering items:

### #1 → API key pool (compliant)

**What it means now**: `accountGroups` already supports multiple
upstream accounts under one group with priority + rate_multiplier.  An
org admin who has multiple OpenAI projects (e.g., per-team budget
isolation) creates one upstream account per project key, groups them,
and the existing scheduler load-balances.

**Work**: probably zero new code at runtime — verify the path works.
Admin UI surface for managing accountGroup membership (currently CLI /
direct DB only?) might want a UX pass.

**LOC estimate**: 0-300 depending on UX scope.

### #2 → caching / dedup (cost optimization)

**What it means now**: cache identical `(model, prompt-hash, params)`
combinations to skip duplicate upstream calls.  Pure cost play.

**Design**:
- Redis-backed cache keyed by SHA-256 of `(model, full request body)`.
- TTL bounded by data freshness needs (5 min default? configurable per
  account-group?).
- Per-org isolation: cache keys prefixed by `orgId` so cross-tenant
  hits never happen — privacy boundary.
- Stream responses are excluded (cache assumes deterministic
  non-stream).
- Opt-in per accountGroup, default off (avoid surprising users with
  cached stale answers).

**Out of scope (boundary check)**: any caching design whose described
benefit includes "reduce calls so platform sees lower volume" — that's
on the wrong side of the line even though the technique is the same.
Cost framing only.

**LOC estimate**: ~500.

### #4 → log masking + RPS limit (compliance + own-protection)

**Log masking**:
- Audit `usage_logs`, `request_bodies`, `request_body_facets`, evaluator
  artefacts for any path that could persist plaintext API keys, OAuth
  tokens, or end-user PII.  Add masking at the record layer (hash keys,
  redact PII patterns) before persistence.

**RPS limit**:
- Per-apiKey rate-limit (already partially via `quotaUsd` but that's
  $-based not RPS-based) — add token-bucket on top.  Goal: protect own
  upstream-quota from a runaway client, not platform-side detection.

**LOC estimate**: ~400 combined.

---

## Anthropic — no change

Plan 5A decision A11: Anthropic OAuth keeps using the legacy
`apps/gateway/src/runtime/oauthRefresh.ts` refresh path.  This plan
explicitly does not touch Anthropic code.  When the unified 4-piece
OAuth refactor finally happens (originally scoped for 5D), it will
include Anthropic; until then, Anthropic OAuth onboarding via the
existing token-paste path through `accounts.create` continues to work.

If a customer asks for "Anthropic via API key" instead of the existing
OAuth path, the same Phase 1 widening applies (Anthropic API keys are
already the existing default; this is already supported).

---

## Open questions

1. **Probe in Phase 1**: re-add a slim probe (only the api_key path) so
   admins get fast typo feedback?  Or skip and rely on first-request
   error messages?  Decision affects Phase 1 LOC.
2. **Phase 2 timing**: does any current user need ChatGPT Team admin
   integration in a specific timeframe, or is this aspirational?
   Affects whether to start Phase 2.0 research in parallel with Phase 1
   implementation.
3. **Cache opt-in default** (Phase 3 #2): per-org default off is safe
   but every org has to opt in — friction.  Per-org default on with
   per-account-group opt-out is more useful but riskier (stale answer
   surprise).  Pick after first real customer feedback.

## How to start the next session

```
讀 .claude/plans/2026-05-04-api-key-migration-plan.md。
從 Phase 1 動工：先處理 platformEnum 加 openai + 對應 admin UI
+ 文件，然後決定 Open question 1 (probe 是否一起加回來)。
```

Phase 0 (5b branch deletion) is calendar-driven — no action needed
until ~2026-05-18.  Phase 2 starts with the Phase 2.0 research task
once Phase 1 is in flight.
