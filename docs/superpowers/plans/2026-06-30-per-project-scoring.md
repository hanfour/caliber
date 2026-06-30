# Per-Project (per-api-key) Scoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score opted-in api_keys as "projects" — a full LLM rubric report per `(user × key × period)` — coexisting with the untouched per-person evaluation path.

**Architecture:** A separate `evaluation_reports_by_key` table mirrors `evaluation_reports` plus `api_key_id`/`key_name_snapshot`. The existing evaluator pipeline (`runRuleBased` → `runEvaluation` → upsert) is parameterized by an optional `apiKeyId` that scopes the usage_logs fetch (bodies/facets follow transitively via `requestId`) and routes the write to the new table. A second additive cron pass enqueues per-key jobs for opted-in keys with traffic, gated by a new dark-launch flag. A pre-existing budget/ledger gap in the deep-analysis LLM step is closed **before** fan-out so the multiplied workload is haltable.

**Tech Stack:** TypeScript, tRPC, drizzle-orm + Postgres 16, BullMQ (apps/gateway workers), Next.js + next-intl (apps/web), vitest + @testcontainers/postgresql.

**Spec:** `docs/superpowers/specs/2026-06-30-per-project-scoring-design.md` (read it fully first).

## Global Constraints

- **Storage = separate table** `evaluation_reports_by_key`. NEVER add `api_key_id` to `evaluation_reports` (silent rollup/getOwnLatest/GDPR contamination).
- The per-person path must stay **byte-identical**: when `apiKeyId` is absent, every function/query/jobId behaves exactly as today. Prove with unchanged existing tests.
- `PR2 (budget-gap close) MUST merge before PR4 (cron fan-out).` Never fan-out unbudgeted deep-analysis.
- jobId: per-person stays `${userId}:${periodStart}:${periodType}` (3-part) when `apiKeyId` is null; per-key is `${userId}:${apiKeyId}:${periodStart}:${periodType}` (4-part).
- Ledger event_type constant `'deep_analysis'`; ref_type `'evaluation_report'` (person) / `'evaluation_report_by_key'` (key) — use a shared exported constant, never a string literal at the call site.
- i18n: any new web string key MUST be added to all five catalogs `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` in the same commit (next-intl throws on a missing key in any active locale).
- New flags: `ENABLE_PROJECT_EVALUATION` (dark-launch, default false), `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` (default true), `EVALUATOR_MAX_PROJECT_KEYS_PER_USER` (default 20), `MAX_PROJECT_KEYS_PER_ORG` (default 50). Add to `packages/config` env schema with these exact names/defaults.
- TDD: every behavioral change starts with a failing test (real-DB via testcontainers for DB/pipeline/router; vitest for units). Commit per task.
- Migration caveat: drizzle journal `when` vs `Date.now()` once skipped a migration on prod — after deploy, verify each migration actually applied; keep an out-of-band `psql` fallback ready.

## File structure

**Create**
- `packages/db/src/schema/evaluationReportsByKey.ts` — new table schema + shared column-builder.
- `packages/db/drizzle/0021_*.sql`, `0022_*.sql`, `0023_*.sql` — migrations (generated).
- `apps/gateway/src/workers/evaluator/upsertEvaluationReportByKey.ts` — by-key upsert (shared builder).
- `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts` — deep-analysis budget gate + ledger write (both grains).
- `apps/web/src/components/evaluator/ProjectScoreSection.tsx` — member "Projects" section.
- `docs/superpowers/specs/...` already exists.

**Modify** (exact sites verified in spec; re-read at edit time)
- `packages/db/src/schema/index.ts` (export new table) · `packages/db/src/schema/apiKeys.ts` (column).
- `apps/gateway/src/workers/evaluator/{runRuleBased,runEvaluation,runLlm,worker,cron,queue}.ts`.
- `apps/api/src/trpc/routers/{apiKeys,reports}.ts` · `apps/api/src/workers/gdprDelete.ts`.
- `packages/auth/...` (new `api_key.evaluate_as_project_set` action) · `packages/config/src/env.ts` (flags).
- `apps/web/src/components/apiKeys/{ApiKeyList,AdminApiKeyList,ApiKeyCreateDialog}.tsx`, `evaluator/ProfileEvaluation.tsx`, `status/ByKeySection.tsx`, `apps/web/messages/*.json`.

---

## Task 1: DB layer — flag column, by-key table, ledger dedup index

**Files:**
- Create: `packages/db/src/schema/evaluationReportsByKey.ts`
- Modify: `packages/db/src/schema/apiKeys.ts`, `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0021_*.sql`, `0022_*.sql`, `0023_*.sql` (via `pnpm --filter @caliber/db db:generate`)
- Test: `apps/api/tests/integration/migrations/0022.test.ts` (+ extend a 0021/0023 test)

**Interfaces:**
- Produces: drizzle table `evaluationReportsByKey` with columns mirroring `evaluationReports` plus `apiKeyId: uuid notNull`, `keyNameSnapshot: text notNull`; unique `(userId, apiKeyId, periodStart, periodType)`. `apiKeys.evaluateAsProject: boolean notNull default false`.

- [ ] **Step 1: Read the reference schemas.** Read `packages/db/src/schema/evaluationReports.ts` (full column list, FK onDelete, indexes), `apiKeys.ts`, `llmUsageEvents.ts` (confirm `tokensInput/tokensOutput` NOT NULL, only `orgMonthIdx`, free-text `eventType/refType`).

- [ ] **Step 2: Write the failing migration test** `apps/api/tests/integration/migrations/0022.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../factories/index.js";
let t: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.stop(); });
describe("migration 0021/0022/0023", () => {
  it("api_keys.evaluate_as_project defaults false", async () => {
    const r = await t.db.execute(sql`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='api_keys' AND column_name='evaluate_as_project'`);
    expect(r.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(String(r.rows[0]!.column_default)).toMatch(/false/);
  });
  it("evaluation_reports_by_key has NOT NULL api_key_id + key_name_snapshot and the 4-tuple unique", async () => {
    const cols = await t.db.execute(sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='evaluation_reports_by_key' AND column_name IN ('api_key_id','key_name_snapshot')`);
    expect(cols.rows).toHaveLength(2);
    for (const c of cols.rows) expect(c.is_nullable).toBe("NO");
    const uniq = await t.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='evaluation_reports_by_key' AND indexdef ILIKE '%UNIQUE%'`);
    expect(uniq.rows.some(r => /user_id.*api_key_id.*period_start.*period_type/i.test(String(r.indexdef)))).toBe(true);
  });
  it("llm_usage_events dedup unique index exists", async () => {
    const r = await t.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='llm_usage_events' AND indexname='llm_usage_dedup_idx'`);
    expect(r.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL.** `pnpm --filter @caliber/api exec vitest run --config vitest.integration.config.ts migrations/0022 --maxWorkers=2` → FAIL (relations/columns missing).

- [ ] **Step 4: Add the flag column** to `apiKeys.ts`:
```ts
evaluateAsProject: boolean("evaluate_as_project").notNull().default(false),
```

- [ ] **Step 5: Create `evaluationReportsByKey.ts`.** Mirror EVERY column from `evaluationReports.ts` (orgId, userId, teamId, periodStart, periodEnd, periodType, rubricId, rubricVersion, totalScore, sectionScores, signalsSummary, dataQuality, llm* columns, sourceBreakdown, triggeredBy*, createdAt, updatedAt) with identical types/onDelete (orgId cascade, userId restrict, teamId set null). Add:
```ts
apiKeyId: uuid("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
keyNameSnapshot: text("key_name_snapshot").notNull(),
// table extras:
uniqByKey: uniqueIndex("evaluation_reports_by_key_uniq").on(t.userId, t.apiKeyId, t.periodStart, t.periodType),
apiKeyTimeIdx: index("erbk_api_key_time_idx").on(t.apiKeyId, t.periodStart),
orgTimeIdx: index("erbk_org_time_idx").on(t.orgId, t.periodStart),
userTimeIdx: index("erbk_user_time_idx").on(t.userId, t.periodStart),
teamTimeIdx: index("erbk_team_time_idx").on(t.teamId, t.periodStart),
```
Export it from `schema/index.ts`. Extract the shared column set into an exported `evaluationReportScoreColumns` object reused by both tables (DRY; later parity test asserts they match).

- [ ] **Step 6: Generate migrations.** `pnpm --filter @caliber/db db:generate`. Then hand-author `0023_llm_usage_events_dedup.sql` (drizzle won't emit a partial unique index): `CREATE UNIQUE INDEX llm_usage_dedup_idx ON llm_usage_events (ref_type, ref_id, event_type) WHERE ref_id IS NOT NULL;` and add the matching down. Add the `0021` partial index `api_keys_eval_project_idx` (org_id) WHERE evaluate_as_project AND revoked_at IS NULL if not generated.

- [ ] **Step 7: Run the test — expect PASS.** Same command as Step 3 → PASS.

- [ ] **Step 8: Schema-parity test.** Add `packages/db/tests/schemaParity.test.ts` asserting `Object.keys(evaluationReportScoreColumns)` is a subset of both tables' columns (catches future drift). Run it.

- [ ] **Step 9: typecheck + commit.** `pnpm --filter @caliber/db typecheck` then:
```bash
git add packages/db apps/api/tests/integration/migrations/0022.test.ts
git commit -m "feat(db): evaluation_reports_by_key + evaluate_as_project flag + ledger dedup index"
```

---

## Task 2: Close the deep-analysis budget+ledger gap (MUST precede cron fan-out)

**Files:**
- Create: `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts`
- Modify: `apps/gateway/src/workers/evaluator/runLlm.ts`, `runEvaluation.ts`, `packages/config/src/env.ts`
- Test: `apps/gateway/tests/.../deepAnalysisBudget.integration.test.ts`

**Interfaces:**
- Consumes: `getMonthSpend(orgId)` and budget from `budgetDeps`/`enforceBudgetWithMetrics`.
- Produces: `deepAnalysisBudgetGate({ db, orgId, enforce })` → `{ skip: boolean }`; `writeDeepAnalysisLedger({ db, orgId, reportId, refType, usageLogRequestId })` (recovers tokens+cost from the usage_log row; `onConflictDoNothing` on `llm_usage_dedup_idx`). Exported const `DEEP_ANALYSIS_EVENT_TYPE = "deep_analysis"`, `REF_TYPE_PERSON/REF_TYPE_KEY`.

- [ ] **Step 1: Read** `runLlm.ts` (confirm zero budget/ledger calls; find where it looks up the loopback usage_log for cost), `runFacetExtraction.ts` (copy the halt/degrade + `createLedgerWriter` pattern), `budgetDeps.ts` (`getMonthSpend` signature).

- [ ] **Step 2: Add env flags** to `packages/config/src/env.ts`: `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` (boolean, default true), `ENABLE_PROJECT_EVALUATION` (boolean, default false), `EVALUATOR_MAX_PROJECT_KEYS_PER_USER` (int, default 20), `MAX_PROJECT_KEYS_PER_ORG` (int, default 50). Add config unit tests asserting defaults; run them.

- [ ] **Step 3: Write failing tests** `deepAnalysisBudget.integration.test.ts`: (a) org over budget → `deepAnalysisBudgetGate({enforce:true})` returns `skip:true`; (b) a deep-analysis success writes exactly ONE `llm_usage_events` row (event_type `deep_analysis`, tokens NOT NULL recovered, cost>0); (c) calling `writeDeepAnalysisLedger` twice with same `reportId` writes only ONE row (dedup); (d) `enforce:false` → never skips but still ledgers. Run → FAIL.

- [ ] **Step 4: Implement `ledgerDeepAnalysis.ts`** — the gate (compare `getMonthSpend(orgId)` to budget, honoring the enforce flag) and the writer (SELECT tokens_input/tokens_output/cost_usd from `usage_logs` by the loopback requestId, INSERT into `llm_usage_events` with `onConflictDoNothing` targeting `llm_usage_dedup_idx`). Use the exported constants.

- [ ] **Step 5: Wire into `runLlm.ts`/`runEvaluation.ts`** — call the gate BEFORE the deep-analysis LLM call (on skip → fall back to rule-based, emit `gwEvalLlmCalledTotal{grain, result:"skipped_budget"}`); call the writer AFTER the Phase-3 upsert (reportId must exist). Add a `grain: "person"|"key"` label to the LLM-called/cost metrics. For now both grains pass `grain:"person"` (key wiring lands in Task 4).

- [ ] **Step 6: Run tests — expect PASS.** Also run the existing evaluator integration subset to prove per-person scoring still works.

- [ ] **Step 7: Commit.** `git commit -m "feat(evaluator): budget-gate + ledger the deep-analysis LLM step (closes spend-blind gap)"`

---

## Task 3: Pipeline per-key — apiKeyId fetch scope + by-key upsert

**Files:**
- Create: `apps/gateway/src/workers/evaluator/upsertEvaluationReportByKey.ts`
- Modify: `runRuleBased.ts`, `runEvaluation.ts`, `worker.ts`
- Test: `apps/gateway/tests/.../perKeyEvaluation.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 table, Task 2 ledger writer.
- Produces: `RunRuleBasedInput.apiKeyId?: string`; `RunEvaluationInput.apiKeyId?: string`, `.keyNameSnapshot?: string`; `upsertEvaluationReportByKey(...)` (onConflict `[userId, apiKeyId, periodStart, periodType]`); `EvaluatorJobPayload.apiKeyId?: string`, `.keyNameSnapshot?: string`.

- [ ] **Step 1: Read** `runRuleBased.ts` (the usage_logs WHERE + the `inArray(requestId, …)` body/facet fetch), `runEvaluation.ts` (the orchestration + Phase-3 upsert call + teamId handling), the per-person `upsertEvaluationReport`.

- [ ] **Step 2: Failing test** `perKeyEvaluation.integration.test.ts`: seed one user with TWO api_keys + usage_logs + request_bodies under each; run `runEvaluation({userId, apiKeyId: keyA, ...})` then `keyB`. Assert: two rows in `evaluation_reports_by_key` (one per key); per-person `evaluation_reports` unchanged; keyA's report only reflects keyA's bodies (cross-key isolation); re-running keyA upserts (no dup). Run → FAIL.

- [ ] **Step 3: Add `apiKeyId` to `runRuleBased`** — append `eq(usageLogs.apiKeyId, apiKeyId)` to the usage_logs WHERE only when set. Body/facet scoping follows transitively (no other change). Verify `coverageRatio` now reflects the key-scoped set.

- [ ] **Step 4: Create `upsertEvaluationReportByKey.ts`** using the shared column-builder, writing `apiKeyId` + `keyNameSnapshot`, deriving `teamId` from the passed api_keys row, onConflict on the 4-tuple.

- [ ] **Step 5: Branch `runEvaluation.ts`** — when `apiKeyId` set, pass it to `runRuleBased`, run the SAME `runLlmDeepAnalysis` (with `grain:"key"`), route Phase-3 to `upsertEvaluationReportByKey`; else byte-identical per-person path. Thread `apiKeyId`/`keyNameSnapshot` through `worker.ts` payload.

- [ ] **Step 6: Run tests — PASS** + existing per-person evaluator tests stay green. Commit `feat(evaluator): per-key evaluation pipeline (apiKeyId-scoped fetch + by-key upsert)`.

---

## Task 4: Queue + cron — 4-part jobId, opt-in × traffic enumeration, caps, dark-launch

**Files:** Modify `queue.ts`, `cron.ts`. Test: `apps/gateway/tests/.../perKeyCron.integration.test.ts`.

**Interfaces:**
- Consumes: Task 3 payload fields; `ENABLE_PROJECT_EVALUATION`, `EVALUATOR_MAX_PROJECT_KEYS_PER_USER`.
- Produces: `enqueueEvaluator` 4-part jobId when `apiKeyId` present; `EnqueueDailyResult` extended with `keyCandidates, keyJobsEnqueued, keyJobsCapped`.

- [ ] **Step 1: Read** `queue.ts:~179` (jobId derivation) and `cron.ts` `enqueueDailyEvaluatorJobs` (org selection `contentCaptureEnabled=true AND deletedAt IS NULL`, per-user enumeration).
- [ ] **Step 2: Failing tests:** (a) jobId is 3-part when apiKeyId null (byte-identical), 4-part when set, and the two NEVER collide; (b) with `ENABLE_PROJECT_EVALUATION=true`, cron enqueues one job per (opted-in key WITH traffic in window); idle/revoked/non-opted keys skipped; (c) per-user cap caps at N, increments `keyJobsCapped`; (d) flag off → zero per-key jobs, per-person counts identical. Run → FAIL.
- [ ] **Step 3: jobId derivation** in `enqueueEvaluator` per Global Constraints. 
- [ ] **Step 4: Second cron pass** behind `ENABLE_PROJECT_EVALUATION`, reusing the same org gate; run the spec §4 `SELECT DISTINCT … EXISTS(traffic)` per org; enqueue with `keyNameSnapshot=ak.name`; apply per-user cap; extend `EnqueueDailyResult`.
- [ ] **Step 5: Run — PASS.** Commit `feat(evaluator): per-key cron fan-out (opt-in × traffic), collision-safe jobId, dark-launch flag`.

---

## Task 5: tRPC — opt-in mutation, per-key report reads, rerun, GDPR parity

**Files:** Modify `apps/api/src/trpc/routers/apiKeys.ts`, `reports.ts`, `apps/api/src/workers/gdprDelete.ts`, `packages/auth/*`. Test: `apps/api/tests/integration/trpc/{apiKeys,reports}.test.ts`, a gdpr test.

**Interfaces:**
- Produces: `apiKeys.setEvaluateAsProject({id, enabled})`; `reports.getOwnByKeyLatest/getOwnByKeyRange/getByKey/listProjectKeys`; `reports.rerun` optional `apiKeyId`; `exportOwn` includes by-key rows; `gdprDelete` purges by-key rows. New auth action `api_key.evaluate_as_project_set`.

- [ ] **Step 1: Read** `apiKeys.ts` (revoke RBAC pattern, `ownColumns`/`orgColumns`, the duplicated `EvaluatorJobPayload` + inline jobId at ~line 396), `reports.ts` (`redactLlm`, getUser/getOwn* patterns, NOT_FOUND anti-enumeration), `gdprDelete.ts` (the `bodies_and_reports` DELETE), the `@caliber/auth` action union + `can()`.
- [ ] **Step 2: Failing tests** covering: opt-in RBAC (owner-self/org_admin allow; other→FORBIDDEN/NOT_FOUND); `getByKey` cross-org→NOT_FOUND; `redactLlm` redaction for non-subject; `rerun` apiKeyId respects ≤30-day guard and emits 4-part jobId; **gdprDelete removes by-key rows**; **exportOwn includes by-key rows**. Run → FAIL.
- [ ] **Step 3:** Add auth action + `can()` entry; implement `setEvaluateAsProject` (audit `api_key.evaluate_as_project_set`); add `evaluateAsProject` to columns; the four report reads against `evaluation_reports_by_key`; extend `rerun` (incl. the duplicated payload + 4-part jobId in lockstep with queue.ts); extend `exportOwn` + `gdprDelete`.
- [ ] **Step 4: Run — PASS** + existing reports/apiKeys tests stay green. Commit `feat(api): per-key opt-in + report reads + rerun + GDPR parity`.

---

## Task 6: Web UI + i18n

**Files:** Modify `ApiKeyList.tsx`, `AdminApiKeyList.tsx`, `ApiKeyCreateDialog.tsx`, `ProfileEvaluation.tsx`, `ByKeySection.tsx`, create `ProjectScoreSection.tsx`, all five `messages/*.json`. Test: web component tests + a Playwright e2e.

- [ ] **Step 1:** Add i18n keys `apiKeys.evaluateAsProject.*` + `evaluator.projects.*` to all five catalogs (en + zh-TW authored; zh-CN/ja/ko best-effort). Run the catalog key-parity lint.
- [ ] **Step 2:** Per-row "Score as project" toggle → `setEvaluateAsProject` (member + admin lists; hidden for revoked); optional create-dialog checkbox. Component tests for states + mutation.
- [ ] **Step 3:** `ProjectScoreSection.tsx` — selector from `listProjectKeys`, render each via the EXISTING `ReportDetail` + `TrendChart`; revoked keys read-only via `key_name_snapshot`. Wire into `ProfileEvaluation.tsx`; add "View project score" in `ByKeySection.tsx`.
- [ ] **Step 4:** Playwright: opt a key in → rerun → owner sees the per-key score render. Run web typecheck + tests. Commit `feat(web): per-key project scoring UI + i18n`.

---

## Task 7: Guardrail finalize + docs

**Files:** Modify opt-in mutation (count caps), metrics/dashboards, release notes.

- [ ] **Step 1:** Enforce `EVALUATOR_MAX_PROJECT_KEYS_PER_USER` AND `MAX_PROJECT_KEYS_PER_ORG` at opt-in time (mutation rejects the N+1th with a clear error). Failing test → implement → PASS.
- [ ] **Step 2:** Confirm `grain` label + `skipped_budget` emitted on all LLM-call metrics; add a dashboard/alert note for `deep_analysis` spend by grain.
- [ ] **Step 3:** Write an operator note (release notes): the one-time per-person behavior change (deep-analysis now ledgered/haltable) + the `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` kill-switch. Commit `feat(evaluator): per-project count caps + observability + operator docs`.

---

## Deferred decisions (confirm during build, do not block)
- periodType granularity for per-key (daily-only first; weekly/monthly later).
- team_manager visibility of team members' per-key reports (recommend parity with `getTeam`).
- whether opt-in triggers an immediate first-window rerun vs waiting for nightly cron (recommend: no auto-rerun; user clicks rerun).
