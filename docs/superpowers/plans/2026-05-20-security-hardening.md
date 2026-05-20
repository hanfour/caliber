# Security Hardening — Implementation Plan (6 PRs)

> **For agentic workers:** This is a multi-PR roadmap. Each PR section below is a self-contained plan. Execute sequentially in declared order — later PRs may depend on shared helpers added by earlier ones (notably PR #1's tenancy assertions).

**Goal:** Close 6 security findings from the 2026-05-20 post-merge audit (cross-tenant scope writes, vulnerable deps, tRPC input log leak, unauthenticated ingest gzip DoS, public /metrics, unreliable client IP).

**Tech Stack:** TypeScript 5.7, Fastify 4, tRPC 11, drizzle-orm 0.36→0.45, Next.js 15.1→15.5.18, vitest 4, testcontainers postgres.

**Cross-PR ground rules:**
- TDD: write failing test → minimal impl → green → commit (per repo CLAUDE rules).
- Every PR body must include `## Why`, `## Verification`, and (if env/migration touched) `## Operator upgrade`.
- Live verification gate: after CI green, smoke against running v0.6.2 stack before claiming done.
- Each PR rebased on latest main before push.

---

## PR #1 — Cross-tenant scope assertions (RBAC / invites / teams)

**Risk:** High. `roles.grantRole`, `invites.acceptInvite`, `teams.create/update/addMember` write `role_assignments` / org-membership rows without proving the `userId`, `teamId`, `departmentId`, or `scopeId` actually belongs to the target org. Cross-tenant privilege grant is possible today.

**Files:**
- Create `apps/api/src/services/tenancy.ts` — central assertions:
  - `assertUserMemberOfOrg(db, userId, orgId)`
  - `assertDepartmentBelongsToOrg(db, departmentId, orgId)`
  - `assertTeamBelongsToOrg(db, teamId, orgId)`
  - `assertRoleScopeCoherent({ role, scope, scopeId, orgId })` — rejects e.g. `role=team_admin` with `scope=org` or `scopeId` from another org.
- Create `apps/api/tests/integration/services/tenancy.test.ts` — cross-tenant attempt matrix per assertion (member of A trying to mount role on B etc.).
- Modify `apps/api/src/services/roles.ts:8` (`grantRole`) — call assertions before insert.
- Modify `apps/api/src/services/invites.ts:25,132` (`createInvite`, `acceptInvite`) — assert `scopeId` ∈ `orgId` at create-time; assert acceptor not crossing tenants at accept-time.
- Modify `apps/api/src/trpc/routers/teams.ts:39` (`create/update/addMember`) — assert department/team/user all share `ctx.orgId`.
- Modify `packages/db/src/schema/roleAssignments.ts` (or wherever the table is) — compound FK `(scope_id, org_id)` if the scope table has `org_id`, OR add a runtime CHECK in a new migration `0015_tenancy_guards.sql`. **Decision tree:**
  - If schema already has `org_id` on `departments`/`teams`/`users` (verify first): add migration 0015 with composite FK.
  - If not: rely on service-layer assertions + add a regression test that exercises the raw SQL path.
- Add integration tests for each tRPC router endpoint that attempts cross-tenant write — must return tRPC `FORBIDDEN` / `BAD_REQUEST` with i18n key, not silent insert.

**Test strategy:**
1. RED: spin up testcontainer with 2 orgs, 1 user in org-A, 1 admin in org-B; admin tries to grant role to org-A user → expect rejection.
2. Same matrix for team `addMember`, invite `create` with cross-org `scopeId`, invite `accept` with mismatched orgId.
3. Use existing `apps/api/tests/factories/db.ts` for setup; follow `apps/api/tests/integration/trpc/teams.test.ts` style.

**Commits:**
1. `feat(api): add tenancy assertion helpers + tests`
2. `fix(api): assert tenancy in roles.grantRole`
3. `fix(api): assert tenancy in invites.create/accept`
4. `fix(api): assert tenancy in teams.create/update/addMember`
5. (optional) `feat(db): 0015 — composite FKs / CHECK constraints for tenancy`

**PR body sketch:**
```
## Why
Audit 2026-05-20 finding #1: role/invite/team writes did not verify that the
target user/team/department actually belonged to the orgId the caller had a
role on. A user with admin scope on org-A could grant roles to org-B users.

## What
- New `apps/api/src/services/tenancy.ts` with 4 assertions reused across
  roles, invites, teams services.
- Each service write path calls the relevant assertion before mutating.
- DB layer: migration 0015 [add or skip depending on schema audit].

## Verification
- Integration tests: <N> new cases covering cross-tenant attempts return
  FORBIDDEN/BAD_REQUEST.
- Smoke: curl tRPC roles.grant with manipulated body on local stack →
  observed rejection.
```

---

## PR #2 — Dependency upgrade (drizzle-orm 0.45.x, next 15.5.18, fast-uri override)

**Risk:** High. `pnpm audit --prod` reports drizzle-orm SQL identifier escaping injection (fixed >= 0.45.2), Next.js App Router middleware bypass + cache poisoning (fixed >= 15.5.18), fast-uri transitive (fixed via override).

**Files:**
- Modify 5 `package.json` files: `packages/db`, `packages/auth`, `packages/gateway-core`, `apps/api`, `apps/gateway` — bump `drizzle-orm` to `^0.45.2` (or latest 0.45.x at time of work).
- Modify `packages/db/package.json` — bump `drizzle-kit` to the version compatible with drizzle-orm 0.45 (check release notes; likely 0.30.x or 0.31.x).
- Modify `apps/web/package.json` — bump `next` from `^15.1.0` to `^15.5.18`.
- Modify root `package.json` — add `pnpm.overrides` for `fast-uri` (pin to patched version, e.g. `^3.0.6`).
- Modify `pnpm-lock.yaml` — regenerated by `pnpm install`.
- Possibly modify `packages/db/src/migrate.ts`, schema files, drizzle-kit config — if 0.36→0.45 changed any API (verify with drizzle changelog).
- Possibly modify Next.js middleware/config if 15.1→15.5 introduced any breaking change (read Next 15.2/15.3/15.4/15.5 changelogs).

**Test strategy:**
1. Run `pnpm install` after bumps, fix any peer-dep complaints.
2. `pnpm typecheck` — first signal of API breakage.
3. `pnpm lint` — second signal.
4. Full `pnpm test:integration` locally with OrbStack running — catches runtime drizzle changes.
5. `pnpm audit --prod` — confirm 10 high → 0 high (or document remaining).
6. Build docker images, restart local stack, smoke test critical paths (`/v1/ingest`, `/dashboard`, login).

**Commits:** one per ecosystem bump to make rollback surgical.
1. `chore(deps): bump drizzle-orm to 0.45.2 + drizzle-kit compatible`
2. `chore(deps): bump next.js to 15.5.18`
3. `chore(deps): pin fast-uri via pnpm overrides`
4. (if needed) `fix: adapt to drizzle 0.45 API changes`

**PR body sketch:**
```
## Why
Audit finding #2: 10 high-severity advisories in prod deps including
drizzle-orm SQL injection (CVE-…) and Next.js middleware bypass.

## What
[changelog summary per bump]

## Operator upgrade
None — pure dep bump. Standard `pnpm install` after pull.

## Verification
- `pnpm audit --prod` before: 10 high. After: <N> high.
- Full integration suite green locally (OrbStack postgres + redis).
- Smoke against v0.6.x stack: /v1/ingest, /dashboard, /api/trpc.users.me.
```

---

## PR #3 — tRPC error log input scrub

**Risk:** Medium/High. `apps/api/src/server.ts:155` logs `input` in `onError`. Redact list in `packages/gateway-core/src/logging/redact.ts:28` covers credentials but not generic `token`/`revealToken`/`inviteToken`/`apiKey`/`password` keys. Failed mutations carrying these in input → cleartext in `api.log`.

**Files:**
- Modify `apps/api/src/server.ts:130-167` — in `onError`, omit `input` entirely when `env.NODE_ENV === "production"`; in dev/test, pass through redaction.
- Modify `packages/gateway-core/src/logging/redact.ts:28` — add: `token`, `revealToken`, `inviteToken`, `apiKey`, `password`, `secret`, `bearer` (case-insensitive paths).
- Create `apps/api/tests/integration/server-onError.test.ts` — provoke a tRPC zod failure on a procedure whose input contains `token`/`password`; assert the log line does NOT contain the cleartext value.

**Test strategy:**
- Use Fastify's `setLogger` injection to capture log records into an array, then assert.
- Cover both prod-mode (no input) and dev-mode-redacted assertions.

**Commits:**
1. `test(api): failing test — onError leaks token in input`
2. `fix(api): omit tRPC input in production logs`
3. `fix(gateway-core): extend redact paths to cover token/revealToken/inviteToken/password`

**PR body sketch:** standard Why/What/Verification.

---

## PR #4 — /v1/ingest gzip auth + decompressed-size cap

**Risk:** Medium. `apps/api/src/rest/ingest.ts:144` decompresses 50MB compressed body before auth check. gzip bomb (50MB → many GB) by unauthenticated attacker.

**Files:**
- Modify `apps/api/src/rest/ingest.ts` — move device Bearer-token verification into a `preHandler`/`preParsing` hook that runs BEFORE the custom gzip parser. If auth fails, 401 without touching body.
- Modify the gzip parser to:
  - Use `createGunzip()` stream with a byte counter; abort + 413 when decompressed bytes exceed `INGEST_MAX_DECOMPRESSED_BYTES` (env, default 200MB).
  - Keep existing 50MB compressed `bodyLimit`.
- Add env knob `INGEST_MAX_DECOMPRESSED_BYTES` to `packages/config/src/env.ts` (or wherever env parsing lives).
- Add tests in `apps/api/tests/integration/rest/ingest.test.ts`:
  - Unauthenticated request with gzip payload → 401, parser MUST NOT have been invoked (assert via spy / no decompression).
  - Authenticated request with payload that decompresses to > cap → 413.
  - Authenticated request under cap → 200.

**Commits:**
1. `test(api): failing tests — ingest auth runs before gzip + decompressed cap`
2. `fix(api): move device auth to preHandler hook before gzip parse`
3. `feat(api): streaming gunzip with decompressed-size cap`
4. `feat(config): INGEST_MAX_DECOMPRESSED_BYTES env knob`

**Operator upgrade note:** new env `INGEST_MAX_DECOMPRESSED_BYTES` (optional, defaults to 200MB).

---

## PR #5 — /metrics private listener + production-public-path close

**Risk:** Medium. `apps/gateway/src/middleware/apiKeyAuth.ts:39` whitelists `/metrics`; metrics expose org/account-id labels. Belt-and-suspenders: separate internal listener AND remove the public allowance.

**Files:**
- Modify `apps/gateway/src/plugins/metrics.ts:78` — register a second Fastify instance bound to `METRICS_HOST` (default `127.0.0.1`) on `METRICS_PORT` (default `9464`). Move `/metrics` route there. Public Fastify no longer serves `/metrics`.
- Modify `apps/gateway/src/middleware/apiKeyAuth.ts:39` — remove `/metrics` from public path list.
- Modify `apps/gateway/src/server.ts` (or wherever the server boots) — start + register `onClose` for the second listener.
- Modify `docker/docker-compose.yml` + `docker/docker-compose.dev.yml` — do NOT expose `9464` externally; only map for `localhost` or skip.
- Add env knobs `METRICS_HOST`, `METRICS_PORT` to `packages/config/src/env.ts`.
- Modify `ops/prometheus/prometheus.yml` (or equivalent) to scrape `gateway:9464` over the internal docker network.
- Add tests:
  - Public listener `/metrics` returns 404.
  - Internal listener `/metrics` returns 200 + valid prom format.

**Commits:**
1. `test(gateway): public /metrics is 404, internal listener serves metrics`
2. `feat(gateway): split metrics onto private 127.0.0.1 listener`
3. `chore(docker,ops): point scrape config at internal metrics port`

**Operator upgrade note:** prometheus scrape target changes from `gateway:3002/metrics` to `gateway:9464/metrics`. Action required for self-hosted operators.

---

## PR #6 — Fastify trustProxy + X-Forwarded-For hardening

**Risk:** Medium. `apps/gateway/src/middleware/apiKeyAuth.ts:109` falls back to socket IP — IP allowlist/blacklist on API keys is bypassable when a reverse proxy fronts the gateway.

**Files:**
- Modify `apps/gateway/src/server.ts` Fastify init — accept `trustProxy: env.GATEWAY_TRUSTED_PROXIES` (CIDR list or boolean). When set, Fastify will use `X-Forwarded-For` correctly.
- Modify `packages/config/src/env.ts` — parse `GATEWAY_TRUSTED_PROXIES` (comma-separated CIDRs).
- Modify `apps/gateway/src/middleware/apiKeyAuth.ts:109` — remove the workaround comment; rely on `req.ip` now-correct value.
- Add tests:
  - With `trustProxy` unset, spoofed XFF is ignored.
  - With `trustProxy=127.0.0.1/32`, XFF from 127.0.0.1 is honoured.
  - With `trustProxy=127.0.0.1/32`, XFF from a different IP is ignored.
- Add the same env to `apps/api/src/server.ts` if api also sits behind proxy.

**Commits:**
1. `test(gateway): trustProxy honours XFF only from configured CIDRs`
2. `feat(gateway): GATEWAY_TRUSTED_PROXIES + Fastify trustProxy wiring`
3. `fix(gateway): remove unreliable socket-IP fallback in apiKeyAuth`

**Operator upgrade note:** new env `GATEWAY_TRUSTED_PROXIES` — operators behind a reverse proxy MUST set this to the proxy's CIDR or IP allowlist enforcement remains broken. Default empty = no XFF trust.

---

## Self-review checklist (writing-plans skill)

- [x] Spec coverage: 6/6 findings each map to one PR section.
- [x] No placeholders inside the PR #1 plan — assertion names + file paths explicit. PRs #2–#6 use directional language ("if 0.36→0.45 changed any API") because exact code requires a fresh read of the changelogs at execution time; that's a deliberate handoff, not a placeholder gap.
- [x] Type consistency: tenancy helper names reused identically across body + PR #1 task list. `INGEST_MAX_DECOMPRESSED_BYTES`, `METRICS_HOST`, `METRICS_PORT`, `GATEWAY_TRUSTED_PROXIES` env names locked here.
