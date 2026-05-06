# Changelog

All notable changes to aide are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Platform mode
releases are tagged `vX.Y.Z`; each tag publishes multi-arch images to
`ghcr.io/hanfour/aide-{api,web,gateway}`.

## Unreleased — pending v0.4.3

### Bug fixes (gateway)

- **#83** — `runFailover` now forwards the api-key's `groupId` to
  `scheduler.select`, plugging a missing wiring that caused
  cross-platform credential leaks. In a mixed-platform org (Anthropic
  OAuth + OpenAI api_key), an `ak_…` key bound to the anthropic group
  could end up dispatched against the OpenAI account because the
  legacy fallback selected by priority only, not by platform. Symptom
  was Anthropic 401 `invalid x-api-key` from `/v1/messages` even when
  the OAuth token was valid (the OpenAI key got sent in the x-api-key
  header to api.anthropic.com). Closes #81.
  - All 12 route call-sites in `messages.ts`, `chatCompletions.ts`,
    `responses.ts` updated to pass `groupId: req.apiKey.groupId ?? null`
  - 2 regression tests added in `failoverLoop.integration.test.ts`
  - Back-compat preserved: `groupId` omitted = legacy org-wide selection
  - Operators with mixed-platform orgs SHOULD bind every api-key to a
    group via the admin UI to avoid the legacy fallback, which is still
    vulnerable when `groupId` is null

## Unreleased — Plan 4C: cost budget + facet enrichment (v0.5.0 candidate)

All Plan 4C code is on `main` but not yet tagged. v0.5.0 will be cut once
the self-org canary observation period defined in
[`docs/UPGRADE-v0.5.0.md`](docs/UPGRADE-v0.5.0.md) completes.

Plan 4C extends the Plan 4B evaluator with **per-org LLM cost budgeting**
(Phase 1) and **LLM facet extraction** (Phase 2). Both phases are gated
behind separate flags so v0.4.0 behaviour is preserved end-to-end when the
org is opted out:

- `ENABLE_FACET_EXTRACTION=false` (default) → Phase 2 entirely sleeps.
- `organizations.llm_facet_enabled=false` (default) → Phase 2 sleeps for
  that org regardless of the env flag.
- `organizations.llm_monthly_budget_usd IS NULL` (default) → cost
  enforcement is unlimited; no behaviour change vs v0.4.0.

### Schema (4 additive migrations, no breaking changes)

- **0004** — `organizations` cost columns (`llm_monthly_budget_usd`,
  `llm_budget_overage_behavior`, `llm_facet_enabled`, `llm_facet_model`,
  `llm_halted_until_month_end`) + `llm_usage_events` ledger.
- **0005** — `request_body_facets` table (one-to-one with `request_bodies`,
  cascade-delete on body purge).
- **0006** — `organizations.llm_halted_at timestamptz` for cheap halt-state
  short-circuiting in `enforceBudget`.
- **0007** — Platform default rubrics bumped to **v1.1.0** with two
  facet-based supportThresholds (interaction → `facet_outcome_success`,
  riskControl → `facet_bugs_caught`). Strictly additive; orgs without
  facet extraction see no scoring change because gte aggregators return
  `hit:false` on empty input.

Each migration ships with a hand-written `*_down.sql` for emergency
rollback (drizzle-kit doesn't generate down migrations).

### Highlights

- **Per-org monthly LLM budget** (`llm_monthly_budget_usd`) with two
  enforcement modes: `degrade` (skip the over-budget call, continue with
  rule-based scoring) or `halt` (stop all LLM evaluation until next UTC
  month). Halt state persists via `llm_halted_at` for cheap short-circuit
  on subsequent calls; auto-clears on month rollover.
- **Cost ledger** (`llm_usage_events`) — each call records
  `{org_id, event_type, model, tokens_input, tokens_output, cost_usd,
  ref_type, ref_id, created_at}`. Source of truth for monthly spend
  aggregation + Grafana dashboards.
- **Cost dashboard** at `/dashboard/organizations/<id>/evaluator/costs`
  with current-month spend, projected end-of-month, breakdowns by
  task / model, and a 6-month history bar chart. Compact widget on the
  evaluator status page links to the full dashboard.
- **LLM facet extraction** — opt-in second LLM pass over each captured
  session, classified into structured JSON (`sessionType`, `outcome`,
  `claudeHelpfulness`, `frictionCount`, `bugsCaughtCount`,
  `codexErrorsCount`). Per-session row in `request_body_facets`. Cache
  via `prompt_version` so changing the prompt forces re-extraction without
  duplicating successful rows.
- **Six new rubric signal types** wired end-to-end (rubric schema → engine
  dispatch → gateway data fetch): `facet_claude_helpfulness`,
  `facet_friction_per_session`, `facet_bugs_caught`, `facet_codex_errors`,
  `facet_outcome_success_rate`, `facet_session_type_ratio`. Empty-rows
  fallback is graceful (gte → `hit:false`, lte → `hit:true`) so rubrics
  referencing facet signals don't break orgs without facet extraction.
- **Report-page facet drill-down** — when facet rows exist for the
  evaluation period, the report page shows total / success rate / avg
  helpfulness + counters + session-type distribution. Hidden silently
  when no rows exist.
- **Observability infrastructure** in `ops/`: 3 Grafana dashboards
  (`evaluator.json`, `body-capture.json`, `gdpr.json`), Prometheus alert
  rules covering DLQ backlog / purge lag / GDPR SLA / facet failure rate
  / cost-budget warnings, and an Alertmanager receiver template.
- **9 runbooks** under `docs/runbooks/` for every alert plus the
  cron-not-firing emergency.
- **Post-release smoke workflow** (`.github/workflows/post-release-smoke.yml`)
  triggered on Release completion: runs `scripts/smoke-evaluator.sh`
  + a Playwright canary spec, opens a `release-blocker` GitHub issue on
  failure.
- **SSE → StreamTranscript integration test** using MSW-mocked Anthropic
  event sequences (3 scenarios: full text, tool_use chunked across 5
  deltas, byte-by-byte feed).

### Breaking changes

- **Web Docker image drops `linux/arm64`** (`ghcr.io/hanfour/aide-web` is
  now amd64-only). The QEMU-based cross-build was unstable. `aide-api`
  and `aide-gateway` continue to publish both architectures. Self-build
  the web image for arm64 with
  `docker buildx build --platform linux/arm64 ./docker/Dockerfile.web`.

### Notes

- **Plan 4C structure**: 18 design parts split into Phase 1 (Parts 1-12,
  cost budget infra) and Phase 2 (Parts 13-18, facet enrichment), plus
  6 follow-up commits after Phase 1 + Phase 2 landed. Full design +
  implementation plans live under `.claude/plans/2026-04-24-*`.
- **`ref_type` / `event_type` columns** are `text` with runtime Zod
  validation, not `pgEnum`. Matches the existing project convention
  (`evaluationReports.triggeredBy`, `.periodType`) and avoids enum
  migrations when new values land.
- **Halt-state precision** now uses `llm_halted_at` directly. Pre-0006
  deployments fell through to a `clearHalt` + re-evaluate path on every
  halted call (2 UPDATEs per call); post-0006 deployments short-circuit
  via a single SELECT.

## v0.4.0 — 2026-04-22 — Plan 4B evaluator shipped

Evaluation subsystem: opt-in content capture, rule-based + LLM scoring, 
admin-customizable rubrics, GDPR workflow, labor-law-friendly transparency.

**14 design decisions** (from `.claude/plans/2026-04-22-plan-4b-evaluator-design.md`):

1. Opt-in per-org content capture (`organizations.content_capture_enabled`); 
   members transparent via `/dashboard/profile/evaluation`.
2. AES-256-GCM body encryption using `CREDENTIAL_ENCRYPTION_KEY` with 
   domain-separated HKDF info (`aide-gateway-body-v1`); 90-day default 
   retention with per-org override (30/60/90).
3. Dual-layer evaluation: rule-based scoring always-on, LLM Deep Analysis 
   opt-in per org.
4. LLM calls dogfooded via self-gateway loopback; cost attribution lands in 
   `usage_logs` under a dedicated system-user `api_key`.
5. Rubric-driven scoring engine with Zod-validated 9-type signal discriminated 
   union (keyword, threshold, refusal_rate, client_mix, model_diversity, 
   cache_read_ratio, extended_thinking_used, tool_diversity, iteration_count).
6. Platform-default rubrics seeded for en/zh-Hant/ja; org-custom rubrics 
   validated client-side + server-side.
7. Upsert-on-rerun semantics for `evaluation_reports` (unique on 
   user+period+type).
8. Four-layer `ENABLE_EVALUATOR` feature gate: env → router procedure → UI 
   route → orchestration cron.
9. LLM Deep Analysis gated on `data_quality.coverageRatio ≥ 0.5` to avoid 
   wasted cost on low-signal windows.
10. GDPR delete as a request/approval workflow (not auto-execute); 30-day SLA 
    triggers auto-reject.
11. Retention purge cron (4h cadence) + GDPR execution cron (5min cadence) 
    separate from main request path.
12. LLM narrative redaction: members always see own full report; team_managers 
    see team reports with LLM fields nulled unless they are also org_admin.
13. Leaderboard visibility is opt-in per org (`leaderboardEnabled`) — privacy 
    default.
14. Body truncation with flipped priority (preserve `attempt_errors` — dropped 
    last) to retain failover debugging context.

### Added

- `@aide/evaluator` workspace package (pure-logic scoring engine + LLM prompt 
  builder)
- Org settings: `/dashboard/organizations/[id]/evaluator/settings`
- Rubric management: `/dashboard/organizations/[id]/evaluator/rubrics` (with 
  dry-run preview)
- Evaluator status: `/dashboard/organizations/[id]/evaluator/status`
- Member detail with 30-day trend + evidence drill-down: 
  `/dashboard/organizations/[id]/members/[uid]`
- Team evaluator aggregate + optional leaderboard: 
  `/dashboard/organizations/[id]/teams/[tid]`
- Org members table latest-score column
- Member self-view: `/dashboard/profile/evaluation`
- GDPR export + deletion request dialogs
- Migration 0002 (4 new tables + 10 `organizations` columns) + 0003 (seed 3 
  platform rubrics)
- BullMQ workers: body capture, evaluator, retention purge, GDPR delete, GDPR 
  auto-reject
- tRPC routers: `contentCapture`, `rubrics`, `reports`, `evaluator` — all 
  gated by `ENABLE_EVALUATOR`
- CI job `evaluator-integration` + Playwright E2E spec + smoke script

### Changed

- `gateway-core` exposes `encryptBody`/`decryptBody` alongside existing 
  `encryptCredential`/`decryptCredential` (refactored to share AES-GCM+HKDF 
  primitive).
- `apiKeyAuth` middleware populates `req.gwOrg.contentCaptureEnabled` + 
  `retentionDaysOverride`.
- Fastify decorators add `bodyCaptureQueue` + `evaluatorQueue` alongside 
  existing `usageLogQueue`.
- RBAC `Action` union extended with 14 new evaluator-scoped actions.

### Docs

- `docs/EVALUATOR.md` — subsystem overview, runbook, env vars, metrics
- `docs/runbooks/evaluator-rollout.md` — 5-step live-deployment playbook
- `docs/GATEWAY.md` — new "Body Capture" section
- `docs/SELF_HOSTING.md` — "Enable the evaluator" section

## v0.3.0 — 2026-04-22 — Plan 4A gateway shipped

### Added

- **Gateway data plane** (`apps/gateway`, port `3002`, opt-in behind the
  `gateway` compose profile + `ENABLE_GATEWAY=true`). Proxies Anthropic
  traffic through a shared pool of upstream accounts.
  - `POST /v1/messages` — Anthropic-native, streaming + non-streaming
  - `POST /v1/chat/completions` — OpenAI-compatible, non-streaming in 4A
  - `GET /health`, `GET /metrics` (Prometheus)
- **Upstream account pool** — admins add `sk-ant-...` API keys or OAuth
  bundles scoped to an org or a specific team; per-account priority,
  concurrency, rate-limit state, and error tracking.
- **Platform API keys** (`ak_...`) — self-issue from `/dashboard/profile`
  or admin-issue for another member via a one-time reveal URL.
  HMAC-SHA256-hashed with a server-side pepper; never stored or logged in
  plaintext.
- **Credential vault** — AES-256-GCM with HKDF-derived per-account
  sub-keys. Master key injected via secret mount only.
- **Failover** — per-request scheduler tries up to
  `GATEWAY_MAX_ACCOUNT_SWITCHES` accounts, classifies upstream errors,
  parks rate-limited / overloaded / decrypt-failed accounts.
- **Smart buffering** — first ~500 ms / ~2 KB of a streaming response is
  buffered so an upstream 5xx mid-connect becomes a clean 5xx client-side.
- **Inline OAuth refresh + cron** — proactive pre-expiry refresh with a
  per-account Redis lock.
- **Usage pipeline** — BullMQ-queued inserts into `usage_logs` with inline
  fallback if the queue is down. Hourly Bernoulli-sampled billing audit
  counts drift between `SUM(usage_logs.total_cost)` and
  `api_keys.quota_used_usd`.
- **Admin tRPC routers** — `accounts.*`, `apiKeys.*`, `usage.*` + new RBAC
  actions (`account.*`, `api_key.*`, `usage.*`).
- **Admin UI** — org accounts list / create
  (`/dashboard/organizations/[id]/accounts`), self-service keys on
  `/dashboard/profile`, admin-issued keys on
  `/dashboard/organizations/[id]/members/[uid]/api-keys`, one-time reveal
  at `/api-keys/reveal/[token]`, org and per-user usage dashboards.
- **Docs** — new `docs/GATEWAY.md` (architecture, client examples, 7-item
  runbook, schema-change policy) + `apps/gateway/README.md`.
  `docs/SELF_HOSTING.md` gains a Gateway § (compose profile, new env vars,
  TLS + secret posture).
- **Infra** — `docker/Dockerfile.gateway` (multi-stage, non-root,
  wget healthcheck), `redis:7-alpine` always-up in compose, new
  `gateway-integration` CI job (testcontainers postgres + redis), new
  `gateway` matrix in `release.yml` for multi-arch images.
- **Playwright E2E** — gateway happy-path + admin-issued one-time URL
  specs (`apps/web/e2e/specs/10-gateway-happy.spec.ts`,
  `11-gateway-admin-issue.spec.ts`) with a stdlib fake Anthropic upstream
  (`apps/web/e2e/fixtures/run-fake-anthropic.mjs`).
- **Post-deploy smoke** — `scripts/smoke-gateway.sh` verifies `/health`,
  `/metrics`, `POST /v1/messages`, and (optionally) a `usage_logs` row.

### Changed

- `packages/config/src/env.ts` — 17 new gateway env vars. Required when
  `ENABLE_GATEWAY=true`: `GATEWAY_BASE_URL`, `REDIS_URL`,
  `CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex), `API_KEY_HASH_PEPPER`
  (32 bytes hex).
- `apps/api` admin routers throw `NOT_FOUND` when the gateway flag is off
  (defense-in-depth; the UI also hides the nav).
- `accounts.create` / `accounts.rotate` now wrap the UI-supplied
  credential in the `{type, api_key | access_token, ...}` envelope the
  gateway expects, instead of encrypting the raw string.

### Notes

- **Schema change policy** (enforced from v0.3.0 onwards): additive only
  (new tables, nullable columns, indexes, `NOT VALID` CHECKs). No enum
  value additions to existing enums, no nullability/type changes. See
  `docs/GATEWAY.md#9-schema-change-policy`.
- **Deferred to post-4A** — streaming for `/v1/chat/completions`,
  wait-queue admission control, sticky sessions, idempotent `X-Request-Id`
  replay, account rotate/edit UI forms, per-request usage detail modal,
  per-team usage drill-down, IP-allowlist UI, scripted credential-key
  rotation.

## CLI v0.1.1 — 2026-05-06 — README refresh (no behaviour change)

npm package `@hanfour.huang/aide`. Pure docs bump — `dist/` and
`templates/` are byte-identical to v0.1.0. Republishes the bundled
`README.md` so the [npm package page](https://www.npmjs.com/package/@hanfour.huang/aide)
surfaces the new platform-mode entry points (`docs/GETTING_STARTED.md`
walkthrough + Pages tutorial CTA), giving CLI-first visitors a path
to the self-hosted personal gateway use case if they want it.

No CLI runtime change. Existing `aide` users have no reason to upgrade
unless they explicitly want the refreshed docs.

## v0.2.0 — Platform mode launched

Self-hostable web platform: Next.js UI + Fastify API, OAuth sign-in,
org-scoped RBAC, invites, audit log. First images published to
`ghcr.io/hanfour/aide-{api,web}`.

## v0.1.0 — CLI initial release

AI Development Performance Evaluator — reads local Claude Code /
Codex usage data and produces evaluation reports. Terminal / JSON /
Markdown / HTML output.
