# Per-Project (per-api-key) Performance Scoring — Design Spec

- **Date:** 2026-06-30
- **Status:** Design approved (brainstorming) → ready for implementation plan
- **Provenance:** Decisions fixed via brainstorming with the operator; full design converged by a 4-proposal × 3-judge multi-agent design panel (winner: cost-ops 22.7/25; grafted with normalization/extensibility/isolation). All load-bearing facts verified against the actual codebase.

## Fixed decisions (operator-chosen — do not re-litigate)

1. **project = api_key**, opt-in via a new boolean column `api_keys.evaluate_as_project` (default false).
2. Per-key reports **coexist** with the existing per-person `evaluation_reports` path (do not remove/replace per-person).
3. Each opted-in key gets a **full LLM rubric score** (the deep-analysis LLM step runs per `(user × key)`).
4. **Only** keys with `evaluate_as_project = true` are scored (primary cost valve).

---

## 0. Summary

Score opted-in api_keys as "projects" with a full LLM rubric per `(user × key × period)`, **coexisting** with the untouched per-person `evaluation_reports` path. Built from the top-ranked cost-ops proposal (separate table + the verified budget-gap close), grafted with: the normalization/extensibility rollup-contamination evidence for storage, isolation's `keyNameSnapshot` + jobId-collision fix, and the corrections every judge flagged — ledger NOT-NULL token recovery, ledger idempotency-via-unique-index, GDPR delete **and** export parity, the duplicated `reports.ts` job payload, and an explicit kill-switch for the one org-wide behavior change.

Verified load-bearing facts: `runLlm.ts` has **zero** budget/ledger calls while `runFacetExtraction.ts` wires `enforceBudget` + `createLedgerWriter` + `callWithCostTracking`; `getMonthSpend` SUMs `cost_usd` from `llm_usage_events` only → **the deep-analysis budget gap is real**. `llmUsageEvents.tokensInput/tokensOutput` are NOT NULL and there is no unique constraint (only `orgMonthIdx`) → the ledger-write needs token recovery + a uniqueness migration. `queue.ts` jobId is `${userId}:${periodStart}:${periodType}` (no apiKeyId). `reports.ts` carries its own duplicate `EvaluatorJobPayload` and inline jobId `${uid}:${input.periodStart}:daily`. `gdprDelete.ts` deletes only `evaluationReports`.

---

## 1. STORAGE DECISION — (b) separate table `evaluation_reports_by_key`

**Decision: (b). Reject (a).** Unanimous across all four lenses; the deciding rationale is verified against real code, not preference:

1. **Silent rollup contamination (decisive).** `reports.getTeam`/`getOrg` select **all** rows by `(orgId|teamId, periodStart)` with **no per-row discriminator**. Under (a), a user's per-person row AND their N per-key rows all match → org/team averages inflate and can exceed 100%. `getOwnLatest` does `orderBy(periodStart desc).limit(1)` with no key filter → a per-key row silently becomes a member's "latest report." `exportOwn` (GDPR access) would leak per-key rows into the person export. Fixing (a) means adding `api_key_id IS NULL` to **6+ read sites** plus the `onConflict` 3-tuple in `runRuleBased.ts` — and **one missed site = silent corruption** of the working, test-covered per-person path.
2. **Integrity.** A per-key report has a **mandatory** `apiKeyId`. (b) makes it `NOT NULL` with a plain unique key — no reliance on PG16 `NULLS NOT DISTINCT` (which only fixes write-side uniqueness, does nothing for the read predicates above).
3. **Cost of (b)** is mirrored scoring columns. Mitigated by a shared Drizzle column-builder, a shared upsert helper parameterized over the target table, reuse of the `EvaluationReportRow` TS type + `redactLlm` + the `ReportDetail` web component, and a **schema-parity test**. Through every lens, isolation > DRY here.

---

## 2. Data model & migrations

### 2.1 `0021_api_keys_evaluate_as_project`
```sql
ALTER TABLE api_keys ADD COLUMN evaluate_as_project boolean NOT NULL DEFAULT false;
CREATE INDEX api_keys_eval_project_idx ON api_keys (org_id)
  WHERE evaluate_as_project = true AND revoked_at IS NULL;   -- cheap cron candidate scan
-- down: DROP INDEX + DROP COLUMN
```
Ensure `usage_logs (api_key_id, created_at)` index exists (verified present as `usage_logs_api_key_time_idx`) for the cron traffic-join EXISTS.

### 2.2 `0022_evaluation_reports_by_key`
Mirror of `evaluation_reports` columns (org_id, user_id, team_id, period_start/end, period_type, rubric_id, rubric_version, total_score, section_scores, signals_summary, data_quality, llm_* columns, source_breakdown, triggered_by*, created_at, updated_at) **plus**:
```sql
api_key_id        uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
key_name_snapshot text NOT NULL,            -- denormalized api_keys.name at eval time
UNIQUE (user_id, api_key_id, period_start, period_type),   -- plain unique, no NULLS NOT DISTINCT
-- indexes: (api_key_id, period_start), (org_id, period_start), (user_id, period_start), (team_id, period_start)
```
- `org_id` → organizations `ON DELETE CASCADE`; `user_id` → users `ON DELETE RESTRICT` (mirrors per-person table; GDPR worker handles erasure); `team_id` `ON DELETE SET NULL`.
- **FK onDelete:** `api_key_id ON DELETE CASCADE`, not RESTRICT. `api_keys.user_id → users` is `ON DELETE CASCADE`, so a user hard-delete cascades into `api_keys`; a RESTRICT here would *block* that. Normal revocation is **soft** (`revoked_at`), so CASCADE never fires on revoke — historical per-key reports survive, and `key_name_snapshot` preserves the label after rename/revoke.
- Down: `DROP TABLE`. Add `packages/db/src/schema/evaluationReportsByKey.ts`, export from `index.ts`, regenerate drizzle snapshot/_journal.
- **Migration-apply caveat (project memory):** drizzle's journal `when` vs `Date.now()` skipped 0016 on prod once; verify 0021/0022 actually apply post-deploy, keep an out-of-band `psql` fallback ready.

### 2.3 `0023_llm_usage_events_dedup` (ledger idempotency)
```sql
CREATE UNIQUE INDEX llm_usage_dedup_idx
  ON llm_usage_events (ref_type, ref_id, event_type)
  WHERE ref_id IS NOT NULL;
```
Lets the new `deep_analysis` ledger write use `onConflictDoNothing`, so BullMQ retries (attempts=3) cannot double-count `getMonthSpend`. `event_type`/`ref_type` remain free-text (verified: no CHECK) so `'deep_analysis'`/`'evaluation_report'`/`'evaluation_report_by_key'` need no enum migration — but add a shared exported constant to prevent silent typo-misbucket.

---

## 3. Pipeline (`apps/gateway/src/workers/evaluator/`)

Parameterize the existing orchestration by an optional `apiKeyId`; only the fetch filter and the persistence target change.

- **`runRuleBased.ts`**: add optional `apiKeyId?: string` to `RunRuleBasedInput`. The only query change is appending `eq(usageLogs.apiKeyId, apiKeyId)` to the existing usage_logs WHERE (`userId` + window). Because `request_bodies`/`request_body_facets` are gathered via `inArray(requestId, requestIds)` derived from that now-key-scoped usage set, body+facet+snippet scoping becomes per-key **automatically — no facet/body schema change** (verified: apiKeyId recovered transitively via requestId). `coverageRatio` and the `LLM_MIN_COVERAGE_RATIO=0.5` gate then operate per `(user×key)` for free (thin keys → rule-based, zero LLM cost).
- **`runEvaluation.ts`**: add optional `apiKeyId` + `keyNameSnapshot`. When set: pass `apiKeyId` into `runRuleBased`; run the **same** `runLlmDeepAnalysis` on key-scoped bodies (decision #3); derive `teamId` **from the api_keys row** (per-person currently writes `teamId` NULL — for by-key we explicitly source `api_keys.team_id` so per-key team rollups work); route Phase-3 write to a new `upsertEvaluationReportByKey` (shared column-builder; `onConflict` target `[userId, apiKeyId, periodStart, periodType]`). When `apiKeyId` absent → existing per-person `upsertEvaluationReport` path runs **byte-identical**.
- **`worker.ts`**: `EvaluatorJobPayload` gains optional `apiKeyId` + `keyNameSnapshot`; worker threads them into `runEvaluation`; rubric/`llmEvalEnabled` resolution unchanged.
- **Budget gap close** (see §6) lives in the deep-analysis path, shared by both grains, shipped **before** fan-out.

---

## 4. Cron (`cron.ts`)

Keep the per-user pass in `enqueueDailyEvaluatorJobs` **100% unchanged**. Add a **second, additive pass** behind a new `ENABLE_PROJECT_EVALUATION` flag (independent dark-launch on top of `ENABLE_EVALUATOR`), reusing the already-selected orgs (`contentCaptureEnabled=true AND deletedAt IS NULL` — the per-key pass must re-inherit this gate). For each org, one traffic-gated query:

```sql
SELECT DISTINCT ak.id AS api_key_id, ak.user_id, ak.org_id, ak.team_id, ak.name
FROM api_keys ak
WHERE ak.org_id = :org AND ak.evaluate_as_project = true AND ak.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM usage_logs ul
              WHERE ul.api_key_id = ak.id
                AND ul.created_at >= :yesterday00Utc AND ul.created_at < :today00Utc);
```
The `EXISTS(traffic in window)` is the secondary cost valve (idle keys enqueue nothing). Enqueue per-key jobs with `keyNameSnapshot = ak.name`, `triggeredBy='cron'`.

**jobId collision fix (verified hazard):** `enqueueEvaluator` (queue.ts:179) must derive
`jobId = apiKeyId ? \`${userId}:${apiKeyId}:${periodStart}:${periodType}\` : \`${userId}:${periodStart}:${periodType}\``.
The per-person 3-part format stays **byte-identical** when `apiKeyId` is null (no dedup regression on deploy). Apply `EVALUATOR_MAX_PROJECT_KEYS_PER_USER` (default 20) to bound fan-out; over-cap keys skipped+counted. Extend `EnqueueDailyResult` with `keyCandidates, keyJobsEnqueued, keyJobsCapped`. Worker concurrency stays 2.

---

## 5. tRPC API

All additive; **no existing procedure signature changes**.

**`apiKeys.ts`**
- `setEvaluateAsProject({ id, enabled })` — new focused mutation (no generic update mutation exists; only revoke/reveal). RBAC mirrors `revoke`: owner-self **or** org_admin. Writes audit `api_key.evaluate_as_project_set`. This is a **new auth action** — wire it into the `@caliber/auth` action union + `can()` registry, not just the router.
- Add `evaluateAsProject` to `ownColumns`/`orgColumns` so `listOwn`/`listOrg` surface toggle state.
- Optionally accept `evaluateAsProject` in `issueOwn`/`issueForUser` (default false) to be born opted-in.

**`reports.ts`** (all read `evaluation_reports_by_key`, reuse `redactLlm`)
- `getOwnByKeyLatest({ apiKeyId })` / `getOwnByKeyRange({ apiKeyId, from, to })` — `report.read_own` + assert `api_keys.userId === ctx.user.id` (NOT_FOUND on mismatch, anti-enumeration). Owner sees full LLM.
- `getByKey({ orgId, apiKeyId, range })` — resolve key owner; assert `key.orgId === input.orgId` (NOT_FOUND otherwise); `report.read_user`; `canSeeLlm = subject-or-org_admin` via `redactLlm`.
- `listProjectKeys({ orgId? })` — opted-in keys (id, name, userId, teamId, latest periodStart) to drive selectors.
- `rerun`: extend with optional `apiKeyId` (scope `"key"`), keep ≤30-day window + existing RBAC; this is the bounded on-demand backfill. **`reports.ts` has its own duplicated `EvaluatorJobPayload` and hardcoded jobId `${uid}:${input.periodStart}:daily`** — both must gain the `apiKeyId` field and the 4-part jobId branch, kept in lockstep with `queue.ts`. (Consider extracting the payload/jobId into a shared package to kill the duplication.)

`usage.ts`: no change — `usage.summary.byKey` already provides the companion per-key cost/traffic view the UI links from.

---

## 6. Cost guardrails — reuse the existing org monthly budget; close the verified deep-analysis gap

**Verified centerpiece:** `runLlm.ts` (deep analysis) calls **neither** `enforceBudget` **nor** any ledger write; only `runFacetExtraction.ts` participates. `getMonthSpend` SUMs `llm_usage_events.cost_usd`. So per-person deep-analysis spend is **already invisible and unhaltable today** — multiplying it per `(user×key)` without a fix = unbounded, unhaltable spend.

**Close it (shipped before fan-out):**
1. **Pre-call halt gate (no estimator needed).** Deep-analysis cost is only known *after* the loopback call. So instead of an inaccurate pre-estimate, do a **halt-state check**: before the LLM call, if `getMonthSpend(orgId) >= budget` → skip LLM, fall back to rule-based, emit `gwEvalLlmCalledTotal{grain, result:"skipped_budget"}`. Same degrade semantics as `runFacetExtraction`'s halt/degrade.
2. **Post-call ledger write (NOT-NULL + idempotency).** After a successful deep-analysis call, recover `tokensInput`, `tokensOutput`, **and** `costUsd` from the usage_log the loopback produced (runLlm already looks up that row for cost — extend it to pull tokens, satisfying the NOT-NULL columns). Write one `llm_usage_events` row: `eventType='deep_analysis'`, `refType='evaluation_report'|'evaluation_report_by_key'`, `refId=reportId`, using **`onConflictDoNothing`** against the new `llm_usage_dedup_idx` so retries don't double-count. Write it **after** the Phase-3 upsert (reportId must exist).

**Behavior-change containment (judges' #1 safety concern).** Closing the gap makes **per-person** deep analysis budget-gated/ledgered for the first time — and even just ledgering it raises `getMonthSpend`, which could trip the *existing* facet halt. Therefore: gate the deep-analysis budget enforcement behind a default-on kill-switch `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` (default `true`), **ledger both grains unconditionally** (honest accounting), but allow operators to disable *enforcement* if a near-budget org sees surprise halts. Document the one-time behavior change in the release notes.

**Layered valves:** (1) opt-in `evaluate_as_project` (decision #4); (2) cron EXISTS-traffic filter; (3) `LLM_MIN_COVERAGE_RATIO=0.5` rule-based fallback; (4) `EVALUATOR_MAX_PROJECT_KEYS_PER_USER` (default 20) **and** `MAX_PROJECT_KEYS_PER_ORG` enforced at opt-in time (the only hard *count* cap; **non-optional**); (5) `ENABLE_PROJECT_EVALUATION` dark-launch; (6) worker concurrency 2.

**Observability:** add a `grain` label (`person|key`) to `gwEvalLlmCalledTotal`/`gwEvalLlmCostUsd` + the `skipped_budget` result value, so per-key vs per-person spend is separable in Prometheus. Rely on existing `gwLlmBudgetWarnTotal`/`gwLlmBudgetExceededTotal` + the new `deep_analysis` ledger rows for dashboards.

---

## 7. UI / i18n (`apps/web`)

- **api-key management** (`ApiKeyList.tsx`, `AdminApiKeyList.tsx`): per-row "Score as project" toggle → `apiKeys.setEvaluateAsProject`; helper text that opting in incurs LLM cost subject to the org monthly budget; hidden for revoked keys (history still readable). Optional checkbox in `ApiKeyCreateDialog.tsx`.
- **member evaluation** (`ProfileEvaluation.tsx` + `dashboard/profile/evaluation`): a "Projects" section under the personal report — selector from `reports.listProjectKeys`, each rendering via the **existing `ReportDetail`** (identical row shape → zero divergence) with `TrendChart`. Revoked keys render read-only via `key_name_snapshot` with a "revoked" marker.
- **status** (`ByKeySection.tsx`): "View project score" affordance next to opted-in keys.
- **admin** (`organizations/[id]/evaluator`): optional per-project leaderboard tab via `getByKey`/`listProjectKeys`.
- **i18n:** add keys under `apiKeys.evaluateAsProject.*` and `evaluator.projects.*` to **all five** catalogs `messages/{en,zh-TW,zh-CN,ja,ko}.json` **in the same commit** (next-intl throws on a missing key in any active locale). Author en + zh-TW now; zh-CN/ja/ko best-effort pending native sign-off (standing #134 gate). Lint for key-parity across catalogs.

---

## 8. Edge cases

- **api_key soft-delete:** revoke is soft (`revoked_at`); cron filters `revoked_at IS NULL` (stops *new* reports), history retained via `key_name_snapshot`. `evaluate_as_project=false` likewise stops new reports, retains history. Project identity does **not** carry across key rotation (new `apiKeyId` = new project — documented in UI).
- **Low coverage:** `< 0.5` → rule-based-only per-key report (consistent with per-person; acceptable "project score" framing).
- **Backfill:** **forward-only** from opt-in. No automatic historical backfill (avoids cost spike). Admins use bounded `rerun` (scope=key, ≤30-day window); note `request_bodies` retention means reruns beyond retention yield coverage<0.5 → rule-based only.
- **Privacy/visibility:** owner-only full LLM on own keys; `report.read_user`/`report.read_org` for admins via `redactLlm`; `getByKey` asserts `key.orgId` match with NOT_FOUND anti-enumeration. (Open: whether team_managers see team members' per-key reports redacted — recommend parity with `getTeam` but confirm.)
- **GDPR — both paths (verified omission in all per-key proposals):**
  - `gdprDelete.ts` (`bodies_and_reports` scope): add a second `DELETE` on `evaluation_reports_by_key` by `(user_id, org_id)`. Required because `api_key_id ON DELETE CASCADE` only fires on key *hard*-delete, not the soft-delete erasure path.
  - `reports.exportOwn` (GDPR access/portability): extend to include the caller's own per-key reports, else right-to-access is incomplete.
- **Ledger idempotency:** handled by `0023` unique index + `onConflictDoNothing` (§2.3/§6).

---

## 9. Build sequence (PRs + test notes)

1. **PR1 — DB layer.** `api_keys.evaluate_as_project` + partial index; `evaluation_reports_by_key` table; `llm_usage_events` dedup unique index; drizzle schema/exports. *Test:* testcontainers — column default false; unique 4-tuple rejects dupes; FK `api_key_id` CASCADE / `user_id` RESTRICT; **schema-parity test** (by_key mirrors evaluation_reports + apiKeyId/keyNameSnapshot); per-person schema diff stays green.
2. **PR2 — Budget-gap close (MUST precede fan-out).** Halt-state pre-check + `deep_analysis` ledger write (token recovery from usage_log, `onConflictDoNothing`, after upsert) in the deep-analysis path for **both** grains; `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` kill-switch; `grain` label + `skipped_budget`. *Test:* over-budget → LLM skipped + rule-based still written; ledger row written once per success; **retry does not double-write** (dedup index); `getMonthSpend` reflects deep-analysis; kill-switch off → no enforcement, still ledgers.
3. **PR3 — Pipeline per-key.** `apiKeyId` filter in `runRuleBased`; `upsertEvaluationReportByKey` (shared builder, teamId from key); `runEvaluation` branch; worker payload fields. *Test:* real-DB — two keys of one user → two distinct rows; per-person row unaffected; per-key body/facet scoping returns only that key's data; upsert idempotent.
4. **PR4 — Queue + cron.** `EvaluatorJobPayload.apiKeyId/keyNameSnapshot`; 4-part jobId derivation; second enumeration pass (opt-in × EXISTS-traffic, org-gate inherited); per-user cap; `ENABLE_PROJECT_EVALUATION`; extended counters. *Test:* enqueues only opted-in keys with traffic; idle/revoked/non-opted skipped; cap enforced; flag off → zero per-key jobs; **per-key jobId never collides with per-person** (dedup test); per-person enumeration counts identical.
5. **PR5 — tRPC.** `apiKeys.setEvaluateAsProject` (+ auth action wiring) + columns; `reports.getOwnByKeyLatest/Range/getByKey/listProjectKeys`; `rerun` apiKeyId (incl. the duplicated `reports.ts` payload + jobId); `exportOwn` extension; `gdprDelete` by-key purge. *Test:* RBAC matrix (owner/self/org_admin/other→NOT_FOUND); `redactLlm` redaction; cross-org NOT_FOUND; rerun ≤30d guard; **GDPR delete removes by-key rows**; **exportOwn includes by-key rows**; existing reports tests untouched + green.
6. **PR6 — Web UI + i18n.** Toggle (member+admin), Projects section reusing `ReportDetail`, ByKeySection link, 5-catalog i18n. *Test:* component states + toggle mutation + selector load; Playwright opt-in → (rerun) → per-key score renders for owner; i18n key-parity lint.
7. **PR7 — Guardrail finalize + docs.** `MAX_PROJECT_KEYS_PER_USER`/`MAX_PROJECT_KEYS_PER_ORG` caps at opt-in; dashboards/alerts for `grain` + `deep_analysis` spend; operator note on the per-person behavior change. *Test:* cap rejects N+1th opt-in; metric emission per grain incl. `skipped_budget`.

---

## 10. Dissent / unresolved risks

- **Per-person behavior change remains a real blast-radius item.** Even with the `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` kill-switch, *ledgering* per-person deep-analysis raises `getMonthSpend` and can trip the existing facet halt for near-budget orgs. Mitigated (kill-switch + release note) but not eliminated — it is the price of making the multiplied workload haltable at all. For the target deployment (one org, ~11 users, tiny per-person volume) the practical risk is low.
- **Shared budget pool starvation.** Per-key and per-person deep analysis draw from the same `llm_monthly_budget_usd`; once halted, heavy per-key usage can starve per-person LLM (and vice-versa). Bounded by count caps, not dollars; no per-grain sub-budget. Left as a deliberate simplification (open: carve a per-key sub-budget later).
- **Two-table drift** is permanent maintenance debt; shared column-builder + parity test reduce but don't remove the dual-edit obligation on every future report column.
- **Queue contention:** per-key jobs share the concurrency-2 evaluator queue with per-person; fine at current scale, may need a priority/separate queue if opt-in volume grows.
- **Deferred decisions** (acceptable to confirm during build): periodType granularity (daily-only vs weekly/monthly rollups), team_manager visibility of team members' per-key reports, and whether opt-in triggers an immediate first-window rerun vs waiting for nightly cron.
