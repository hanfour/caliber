# GitHub Delivery PR 3 — LLM Quality Layer + @caliber/queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 3 of GitHub delivery scoring (spec Component 4): a bounded LLM quality adjustment (±15) on delivery reports — sampled merged-PR diffs judged via the gateway loopback, budget-enforced and ledgered — plus the `@caliber/queue` extraction mandated as commit 1 by PR 2's final review.

**Architecture:** Commit 1 consolidates the 6 lockstep queue sites into a new `packages/queue`. The quality layer reuses the evaluator's proven machinery: `createFacetLlmClient` (org-generic loopback client with the `x-caliber-eval-account-id` pin), `enforceBudget`/`createBudgetDeps` (zero pre-estimate halt gate), `llm_usage_events` ledger with the `(ref_type, ref_id, event_type)` dedup index, and `usage_logs` cost polling by `x-request-id`. Pure pieces (sampler, prompt, parser with server-side clamp) live in `packages/evaluator/src/delivery/`; the I/O orchestrator `runDeliveryQuality.ts` lives beside `runDeliveryEval.ts`, which merges the result into the report upsert (`total = clamp(quant + adjustment, 0, 120)`).

**Tech Stack:** Same as PR 1/2. NO migration (all columns exist on `github_delivery_reports`).

## Global Constraints

- `llm_status` vocabulary: `'ok' | 'skipped' | 'parse_error' | 'budget_denied'` (documented on the schema). LLM runs ONLY when quant produced a score: `insufficientData`, `noIdentity`, no-merged-PRs, org `llm_eval_enabled=false`, missing `llm_eval_model`, or missing connection → `skipped`. Budget gate denial → `budget_denied`. Two invalid-JSON attempts → `parse_error`. Quant score ALWAYS survives — the LLM layer can never fail a report.
- Adjustment clamped server-side to [-15, 15] REGARDLESS of model output; `totalScore = clamp(quantTotal + adjustment, 0, 120)`, 1dp. `llm_quality_adjustment` stores the clamped value.
- Loopback call: `POST {gatewayBaseUrl}/v1/messages`, `Authorization: Bearer <redis GET caliber:gw:llm-eval-key:{orgId}>`, `anthropic-version: 2023-06-01`, pin header `x-caliber-eval-account-id: <organizations.llm_eval_account_id>` when set — all via the EXISTING `createFacetLlmClient` (`apps/gateway/src/workers/evaluator/facetLlmClient.ts:48` — it is org-generic; do not fork it). Model = org `llm_eval_model`; `max_tokens` 4000.
- Ledger: event type `"delivery_analysis"`, ref type `"github_delivery_report"`, ref id = report row id; dedup rides the existing `llm_usage_dedup_idx (ref_type, ref_id, event_type)`. Cost/tokens recovered from `usage_logs` by the response's `x-request-id` (poll ≤3 × 250ms — `runLlm.ts:17-18` idiom); missing request id loses cost attribution but never the report.
- Budget: reuse `enforceBudget` + `createBudgetDeps` + `isBudgetError` (zero pre-estimate, fail-open on non-budget errors) and the SAME kill-switch env `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` — "identical to deep analysis" per spec; no new env.
- Diff fetch at eval time only: Accept `application/vnd.github.diff`, response is TEXT (bypasses the json handler); truncated per-file (4,000 chars) and ~30,000 chars total; NOTHING from the fetch is persisted except report fields. Up to 20 review comments per PR (`GET /pulls/{n}/comments`). Sampling: top **5** merged PRs by `log(additions+deletions+1)` desc, tie-break `mergedAt` desc.
- Parse resilience: attempt 1 → invalid → ONE retry with a corrective suffix → invalid → `parse_error`. (Net-new behavior — no existing retry precedent; closest idiom is runLlm's poll loop.)
- `@caliber/queue`: single shared `CALIBER_QUEUE_PREFIX = "caliber:gw"` + single `DEFAULT_JOB_OPTIONS` (the byte-identical triple); per-queue modules for evaluator/github-sync/github-delivery. ZERO behavior change; every existing test keeps passing with only import-path updates.
- Commit format: `<type>(<scope>): <description>` — NO Co-Authored-By trailer. Branch `feat/github-delivery-pr3-llm` (exists, from `5a97ef6`). `noUncheckedIndexedAccess` on.

---

### Task 1: `@caliber/queue` package extraction (zero behavior change)

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/tsconfig.json`, `packages/queue/tsconfig.build.json`
- Create: `packages/queue/src/index.ts`, `src/shared.ts`, `src/evaluator.ts`, `src/githubSync.ts`, `src/githubDelivery.ts`
- Move tests: `packages/queue/tests/githubSync.test.ts`, `tests/githubDelivery.test.ts` (from the two gateway queue unit-test files), `tests/evaluator.test.ts` (payload/options cases from `apps/gateway/tests/workers/evaluatorQueue.test.ts` that are pure — leave gateway-specific ones in place if any touch worker wiring)
- Rewrite as thin re-exports (do NOT delete — too many importers): `apps/gateway/src/workers/evaluator/queue.ts`, `apps/gateway/src/workers/githubSync/queue.ts`, `apps/gateway/src/workers/githubDelivery/queue.ts` → each becomes `export * from "@caliber/queue/<module>";` style (or root) re-export ONLY
- Modify: `apps/api/src/trpc/routers/reports.ts` (drop local constants/types, import from `@caliber/queue`, KEEP its existing `export` statements as re-exports so downstream importers of reports.ts don't break), `apps/api/src/trpc/routers/githubDelivery.ts` (drop both duplicated builder/constant blocks + their TODOs; import from `@caliber/queue`; keep `MAX_GENERATE_WINDOW_DAYS` — that one is API-domain, not queue), `apps/api/src/server.ts` (drop re-declared names/prefixes and the three inlined `defaultJobOptions` objects — construct via `@caliber/queue`'s factories), plus `apps/api/package.json` + `apps/gateway/package.json` add `"@caliber/queue": "workspace:*"`

**Interfaces (the package's public API — everything below already exists verbatim in the gateway modules; this is a MOVE, not a rewrite):**

```ts
// shared.ts
export const CALIBER_QUEUE_PREFIX = "caliber:gw";
export const DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { age: 86400, count: 500 }, removeOnFail: { age: 7 * 86400 } } as const satisfies JobsOptions;
export interface QueueLike { add(name, data, opts?): Promise<unknown>; remove?(jobId): Promise<unknown>; close?(): Promise<void>; }
export function buildQueueOptions(opts: { connection; prefix?; defaultJobOptions? }): QueueOptions; // deep-copies backoff, spreads caller last — the existing idiom
// evaluator.ts: EVALUATOR_QUEUE_NAME, EVALUATOR_JOB_NAME, EvaluatorJobPayload (zod + type), createEvaluatorQueue, enqueueEvaluator (jobId still via @caliber/evaluator's buildEvaluatorJobId — @caliber/queue depends on @caliber/evaluator one-way)
// githubSync.ts: GITHUB_SYNC_QUEUE_NAME/JOB_NAME, GithubSyncJobPayload, buildGithubSyncJobId, createGithubSyncQueue, enqueueGithubSync (remove-before-add + its comment)
// githubDelivery.ts: GITHUB_DELIVERY_QUEUE_NAME/JOB_NAME, GithubDeliveryJobPayload, buildGithubDeliveryJobId (+ the periodType comment), createGithubDeliveryQueue, enqueueGithubDelivery (regenerate option)
// Legacy prefix aliases: export const EVALUATOR_QUEUE_PREFIX = CALIBER_QUEUE_PREFIX; (same for GITHUB_SYNC_QUEUE_PREFIX / GITHUB_DELIVERY_QUEUE_PREFIX) — keeps all existing import names valid via the re-export shims.
```

- [ ] **Step 1:** Scaffold `packages/queue` copying `@caliber/i18n-validation`'s package.json/tsconfig pattern exactly (private, type module, dist main/types, exports map with "." triple + "./package.json", scripts build/lint/typecheck/test, deps: `bullmq`, `zod`, `@caliber/evaluator: workspace:*`; devDeps typescript/vitest/@types/node — match versions from apps/gateway's package.json for bullmq).
- [ ] **Step 2:** Move the three gateway queue modules' contents into the package modules per the Interfaces block, deduplicating prefix + options into `shared.ts`. Root `index.ts` re-exports all four modules.
- [ ] **Step 3:** Rewrite the three gateway `queue.ts` files as pure re-export shims (one or two lines each) so every existing gateway import path keeps working.
- [ ] **Step 4:** Update apps/api: reports.ts / githubDelivery.ts / server.ts per the Files list — all six TODO blocks deleted; server.ts's three `new Queue(...)` calls become `createEvaluatorQueue({ connection: bullmqRedis })` etc.
- [ ] **Step 5:** Move/adapt the pure queue unit tests into `packages/queue/tests/` (same assertions; only import paths change). Delete the originals that were moved; keep any gateway test that exercises worker wiring where it is.
- [ ] **Step 6:** Verify — this is the task's whole point:
  - `pnpm --filter @caliber/queue test` (moved suites green)
  - `pnpm turbo run lint typecheck test` → 38+ tasks green (new package adds tasks)
  - `pnpm --filter @caliber/gateway test:integration githubSync githubDelivery` and `pnpm --filter @caliber/api test:integration githubDelivery reports` → green, proving zero behavior change
- [ ] **Step 7:** Commit: `refactor(queue): extract @caliber/queue — dedupe 6 lockstep constant/jobId/options sites`

---

### Task 2: Weekly cron `auth_error` parity

**Files:**
- Modify: `apps/gateway/src/workers/githubDelivery/weeklyCron.ts` (tick query)
- Test: `apps/gateway/tests/workers/githubDelivery/weeklyCron.integration.test.ts` (one new seeded org)

- [ ] **Step 1 (RED):** In the existing "tick enqueues …" test, add a fourth org: `insertConnection(db, orgE.id, { status: "auth_error" })` + a member WITH a github account (fresh gh-id — accounts PK is global) + `organizationMembers` row. Assert it is NOT enqueued (existing orgA-only assertions must stay green). Run `pnpm --filter @caliber/gateway test:integration githubDelivery/weeklyCron` → the new assertion FAILS (auth_error org currently enqueued).
- [ ] **Step 2 (GREEN):** Add `ne(githubConnections.status, "auth_error")` to the tick query's `and(...)` (import `ne`; mirror `githubSync/interval.ts:51`). Update the file-header comment. Re-run → PASS.
- [ ] **Step 3:** Commit: `fix(gateway): weekly delivery cron skips auth_error connections (parity with sync tick)`

---

### Task 3: GitHub client — diff/comments/body + truncation

**Files:**
- Modify: `apps/gateway/src/workers/githubSync/githubClient.ts` (two methods + one field)
- Create: `packages/evaluator/src/delivery/truncateDiff.ts` (+ barrel line in `delivery/index.ts`)
- Test: `apps/gateway/tests/workers/githubSync/githubClient.test.ts` (extend), `packages/evaluator/tests/delivery/truncateDiff.test.ts`

**Interfaces (produced):**

```ts
// githubClient.ts additions
getPullDiff(repoFullName: string, number: number): Promise<string>;      // Accept: application/vnd.github.diff → res.text()
listReviewComments(repoFullName: string, number: number): Promise<GithubApiReviewComment[]>; // GET /repos/{r}/pulls/{n}/comments, paginated, JSON
export interface GithubApiReviewComment { body: string; user: GithubApiUser | null; path?: string; }
// GithubApiPullDetail gains: body?: string | null;
// truncateDiff.ts (pure)
export const DIFF_MAX_TOTAL_CHARS = 30_000;
export const DIFF_MAX_FILE_CHARS = 4_000;
export function truncateDiff(diff: string, opts?: { maxTotalChars?: number; maxFileChars?: number }): string;
// splits on /^diff --git /m boundaries; each file section hard-capped at maxFileChars with a "\n…[truncated]\n" marker; concatenation stops before exceeding maxTotalChars with a trailing "…[N more files truncated]" marker. Pure, never throws on arbitrary text.
```

- [ ] **Step 1 (RED):** Client tests: `getPullDiff` sends `accept: application/vnd.github.diff` and returns raw text (fake fetch returns `new Response("diff --git a/x b/x\n+1", {status:200})`); non-2xx maps through the SAME error taxonomy (401→GithubAuthError etc. — the text path must reuse `handleResponse`'s status branches BEFORE reading text); `listReviewComments` paginates and returns bodies. truncateDiff tests: per-file cap (two files, first oversize → first capped w/ marker, second intact), total cap (many files → output ≤ maxTotal + files-truncated marker), passthrough when under caps, empty string ok.
- [ ] **Step 2 (GREEN):** Implement. In the client: refactor the status-checking half of `handleResponse` into `checkStatus(res, path)` (throws the taxonomy, returns void), so `request()` = checkStatus + `res.json()` and the new `requestText(path, accept)` = checkStatus + `res.text()`. `getPullDiff` uses `requestText(\`/repos/${repo}/pulls/${n}\`, "application/vnd.github.diff")` (per-request accept override in the fetch headers). Add `body?: string | null` to `GithubApiPullDetail`.
- [ ] **Step 3:** `pnpm --filter @caliber/gateway test githubClient` + `pnpm --filter @caliber/evaluator test delivery/truncateDiff` + both typechecks → green.
- [ ] **Step 4:** Commit: `feat(gateway,evaluator): PR diff/comment fetch (text path) + pure diff truncation`

---

### Task 4: Pure quality pieces — sampler, prompt, parser

**Files:**
- Create: `packages/evaluator/src/delivery/qualitySampler.ts`, `qualityPrompt.ts`, `qualityParser.ts` (+ 3 barrel lines)
- Test: `packages/evaluator/tests/delivery/qualitySampler.test.ts`, `qualityPrompt.test.ts`, `qualityParser.test.ts`

**Interfaces (produced, consumed by Task 5):**

```ts
// qualitySampler.ts
export const QUALITY_SAMPLE_SIZE = 5;
export interface QualityPullCandidate { repoFullName: string; number: number; title: string; additions: number; deletions: number; mergedAt: Date; }
export function samplePullsForQuality(pulls: QualityPullCandidate[], n = QUALITY_SAMPLE_SIZE): QualityPullCandidate[];
// rank: Math.log(additions + deletions + 1) desc; tie-break mergedAt desc; returns NEW array, input untouched.

// qualityPrompt.ts
export interface QualityPromptPr { repoFullName: string; number: number; title: string; body: string | null; diff: string; reviewComments: string[]; }
export function buildDeliveryQualityPrompt(input: { windowDays: number; quantTotal: number; sectionSummary: Array<{ key: string; score: number | null }>; prs: QualityPromptPr[]; }): { system: string; user: string };
// system: role = senior eng assessing delivery quality from real PRs; MUST reply with ONLY a JSON object {"qualityAdjustment": number in [-15,15], "narrative": string (zh-TW, 3-6 sentences), "evidence": [{"repo","prNumber","quote","reason"}] (1-5 items, quote ≤200 chars, verbatim from the diff/comments)}; no markdown fences, no prose outside JSON.
// user: quant context (windowDays/quantTotal/section scores) + per-PR blocks (repo#number, title, body, ≤20 comments, truncated diff).
export const QUALITY_RETRY_SUFFIX = "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object — no fences, no commentary.";

// qualityParser.ts
export const QUALITY_ADJUSTMENT_LIMIT = 15;
export type QualityParseResult = { ok: true; qualityAdjustment: number; narrative: string; evidence: Array<{ repo: string; prNumber: number; quote: string; reason: string }> } | { ok: false; error: string };
export function parseDeliveryQualityResponse(raw: string): QualityParseResult;
// coerce: raw JSON → ```json fences → outermost {…} slice (the responseParser.ts:85-128 approach, reimplemented locally & small); zod-validate; CLAMP qualityAdjustment to ±15 server-side (out-of-range input is ok:true clamped, NOT an error); evidence trimmed to 5, quotes sliced to 200.
```

- [ ] **Step 1 (RED):** Tests — sampler: ranks by log-size (big PR beats small), tie-break newer-merged wins, n cap, returns new array (input order preserved), empty → empty. Prompt: system contains the JSON contract + "±15"-bounds text + zh-TW narrative instruction; user contains each repo#number + truncated diff + quant total; retry suffix constant exported. Parser: valid JSON ok; fenced JSON ok; prose-wrapped ok; adjustment 40 → clamped 15 (ok); -99 → -15; missing narrative → ok:false; garbage → ok:false; >5 evidence trimmed; >200-char quote sliced.
- [ ] **Step 2 (GREEN):** Implement the three modules + barrel lines.
- [ ] **Step 3:** `pnpm --filter @caliber/evaluator test delivery` (all delivery suites) + typecheck → green.
- [ ] **Step 4:** Commit: `feat(evaluator): delivery quality sampler, prompt builder, clamped parser`

---

### Task 5: `runDeliveryQuality.ts` (gateway orchestrator)

**Files:**
- Create: `apps/gateway/src/workers/githubDelivery/runDeliveryQuality.ts`
- Modify: `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts` (widen `DeepAnalysisRefType` union with `"github_delivery_report"`, add optional `eventType` input defaulting to `DEEP_ANALYSIS_EVENT_TYPE`, export `DELIVERY_ANALYSIS_EVENT_TYPE = "delivery_analysis"`)
- Test: `apps/gateway/tests/workers/githubDelivery/runDeliveryQuality.integration.test.ts`

**Interfaces (produced, consumed by Task 6):**

```ts
export interface RunDeliveryQualityInput {
  db: Database; redis: Redis; gatewayBaseUrl: string; masterKeyHex: string;
  orgId: string; ghUserId: number; reportId: string;
  window: { start: Date; end: Date };
  quant: { totalScore: number; windowDays: number; sections: Array<{ key: string; score: number | null }> };
  fetchImpl?: typeof fetch; sleepMs?: number;
  logger?: LoggerLike;
}
export type DeliveryQualityResult =
  | { status: "skipped"; reason: "disabled" | "no_model" | "no_connection" | "no_merged_prs" }
  | { status: "budget_denied" }
  | { status: "parse_error"; model: string }
  | { status: "ok"; qualityAdjustment: number; narrative: string; evidence: unknown[]; model: string; calledAt: Date; costUsd: number | null };
export async function runDeliveryQuality(input: RunDeliveryQualityInput): Promise<DeliveryQualityResult>;
```

Flow (each branch integration-tested):
1. Load org (`llmEvalEnabled, llmEvalModel, llmEvalAccountId`): disabled/no-model → skipped. Budget gate: `deepAnalysisBudgetGate`-shaped check via `enforceBudget(orgId, 0, createBudgetDeps(db))` + `isBudgetError` + the `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS` kill-switch (import the existing helpers; do NOT reimplement) → `budget_denied`. Fail-open on non-budget errors.
2. Load connection (full row) → absent → skipped `no_connection`; decrypt PAT (salt = row id, `decryptCredential`), `createGithubClient({ token, fetchImpl })`.
3. Candidates: SELECT merged PRs in window by `authorGhId = ghUserId` with `repoFullName/number/title/additions/deletions/mergedAt` → `samplePullsForQuality` → empty → skipped `no_merged_prs`.
4. Per sampled PR (sequential, ≤5): `getPull` (body), `getPullDiff` → `truncateDiff`, `listReviewComments` (slice 20, map to body strings). Any per-PR GitHub error → drop that PR (log via `logger?.warn` + `safeErrorMessage`), continue; ALL dropped → skipped `no_merged_prs`.
5. `buildDeliveryQualityPrompt` → `createFacetLlmClient({ redis, gatewayBaseUrl, orgId, evalAccountId, fetchImpl })` → call `{ model: llmEvalModel, maxTokens: 4000, system, user }`. Parse failure on attempt 1 → ONE retry with `user + QUALITY_RETRY_SUFFIX`; parse failure again → `{ status: "parse_error", model }` (terminal). LLM TRANSPORT errors (client throw / non-2xx status) are different: RETHROW so the whole job retries via BullMQ — transient upstream, mirrors facet's transient-vs-deterministic split. Budget/skip outcomes are terminal; transport is transient. Document this split in the file header.
6. On ok: poll `usage_logs` by `x-request-id` for cost (`LLM_COST_LOOKUP_MAX_ATTEMPTS/DELAY_MS` idiom, `sleepMs` seam); ledger via the widened `writeDeepAnalysisLedger` with `refType: "github_delivery_report"`, `eventType: DELIVERY_ANALYSIS_EVENT_TYPE`, `reportId`; ledger failure must NOT fail the result (log, `costUsd` stays whatever the poll found).

Integration tests (PG container; fake fetch routes github.com + loopback; `insertOrg` needs org columns `llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5-20251001"`; seed eval key in an `ioredis-mock` at `caliber:gw:llm-eval-key:{orgId}`): ok path (valid JSON + `x-request-id` header + seeded `usage_logs` row → costUsd recovered, ledger row written with dedup-safe re-run); clamp (model returns 40 → stored 15); retry-then-ok (first response invalid, second valid → 2 loopback calls asserted); parse_error (two invalid); budget_denied (org `llmHaltedUntilMonthEnd: true`); disabled → skipped; pin header present on the loopback request when `llmEvalAccountId` set.

- [ ] **Step 1 (RED):** Write the integration tests → module not found.
- [ ] **Step 2 (GREEN):** Implement `runDeliveryQuality.ts` + the surgical `ledgerDeepAnalysis.ts` widening (existing deep-analysis tests must stay green — run `pnpm --filter @caliber/gateway test:integration ledgerDeepAnalysis` if such a suite exists, else the evaluator integration files touching it).
- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration githubDelivery/runDeliveryQuality` + typecheck → green.
- [ ] **Step 4:** Commit: `feat(gateway): runDeliveryQuality — sampled-PR loopback judgment, budget-gated, ledgered`

---

### Task 6: Merge into `runDeliveryEval` + thread deps through worker/server

**Files:**
- Modify: `apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts` (call quality after quant; merge fields into upsert)
- Modify: `apps/gateway/src/workers/githubDelivery/worker.ts` (opts gain `redis: Redis; gatewayBaseUrl: string`)
- Modify: `apps/gateway/src/server.ts` (`wireGithubSyncPipeline` passes `redis: githubRedis`, `gatewayBaseUrl: env.GATEWAY_LOCAL_BASE_URL` to `createGithubDeliveryWorker`)
- Test: extend `apps/gateway/tests/workers/githubDelivery/runDeliveryEval.integration.test.ts` + `worker.integration.test.ts`

Semantics: after `scoreDelivery`, if `noIdentity || insufficientData || totalScore === null` → upsert with `llmStatus: "skipped"` (today's behavior). Else run `runDeliveryQuality`; upsert mapping: `ok` → `llmStatus "ok"`, `llmQualityAdjustment` (string via toString — decimal), `llmNarrative`, `llmEvidence`, `llmModel`, `llmCalledAt`, `llmCostUsd` (string|null), and `totalScore = clamp(quant + adjustment, 0, 120)` (1dp, stored as string); `skipped/budget_denied/parse_error` → `llmStatus` accordingly, quant `totalScore` unchanged, llm columns null except `llmModel` on parse_error. `redis`/`gatewayBaseUrl` become REQUIRED on `RunDeliveryEvalInput` (worker always has them; tests updated — pass ioredis-mock + a dummy base URL for quant-only tests where LLM is skipped anyway).

- [ ] **Step 1 (RED):** Extend runDeliveryEval tests: ok path end-to-end (org llm-enabled + eval key in redis-mock + loopback route in routeFetch → report `llmStatus "ok"`, totalScore = quant+adjustment clamped, narrative stored); insufficient-data path still `skipped` with NO loopback call (assert fetch never hit `/v1/messages`); parse_error path (quant preserved). Existing 5 tests updated for the new required inputs.
- [ ] **Step 2 (GREEN):** Implement merge + threading. Worker e2e test gains `redis`/`gatewayBaseUrl` wiring (org llm-disabled → unchanged skipped behavior proves dark-path parity).
- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration githubDelivery` (all files) + typecheck → green.
- [ ] **Step 4:** Commit: `feat(gateway): delivery reports gain LLM quality adjustment (clamp ±15, quant always survives)`

---

### Task 7: API `getReport` exposes the LLM fields

**Files:**
- Modify: `apps/api/src/trpc/routers/githubDelivery.ts` (`getReport` select adds `llmQualityAdjustment`, `llmNarrative`, `llmEvidence`, `llmModel`, `llmCalledAt` — NOT `llmCostUsd`, cost stays admin-internal until a PR4 decision)
- Test: extend the getReport it in `apps/api/tests/integration/trpc/githubDelivery.test.ts` (seed a report row with the llm fields → response carries them; llmCostUsd absent from the response object)

- [ ] **Step 1 (RED)** → **Step 2 (GREEN)** → **Step 3:** `pnpm --filter @caliber/api test:integration githubDelivery` + typecheck → green.
- [ ] **Step 4:** Commit: `feat(api): getReport returns delivery LLM narrative/adjustment/evidence`

---

### Task 8: Full verification + PR

- [ ] `pnpm turbo run lint typecheck test`; `pnpm --filter @caliber/gateway test:integration`; `pnpm --filter @caliber/api test:integration` — all green.
- [ ] Push (gh account gotcha first): `git push -u origin feat/github-delivery-pr3-llm`.
- [ ] PR per repo convention; note: dark, no migration, PR 4 (UI) is the last piece before flag-flip + live smoke; `@caliber/queue` closes the 6 lockstep TODOs; refs #270 (no `Close #NN`).
- [ ] Final whole-branch review (fable) before merge — SDD flow as before.

## Coverage / deviation notes

- Transport errors during the LLM call rethrow → BullMQ retry (transient), unlike parse errors (terminal `parse_error`). Deliberate: mirrors facet's transient-vs-deterministic split.
- `max_tokens` 4000 (narrative + evidence only — deep analysis needs 8000 for full reports; delivery output is small).
- Test-fixture extraction (final-review triage #7) deliberately deferred again: PR 3 adds one new test file; the consolidation pays off in PR 4's web-side work instead.
- `llmCostUsd` not exposed via getReport (member-facing) — cost visibility stays with the org-admin evaluator cost surfaces; revisit in PR 4 if the UI wants it.
