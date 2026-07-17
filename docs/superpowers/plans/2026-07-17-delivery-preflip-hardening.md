# Delivery Pre-Flip Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the whole of issue #270 so `ENABLE_GITHUB_DELIVERY` can flip on: silent-failure visibility, unbounded-loop caps, budget alerting parity, prompt char caps, request-id ledger dedup (migration 0033), the evaluator-cron coalescing port, and the two deferred edge-case tests.

**Architecture:** Eight independent hardening tasks against already-merged code. Each mirrors an in-repo precedent (`interval.ts`'s coalescing, `truncateDiff`'s cap idiom, `deepAnalysisBudgetGate`'s metrics wiring, `githubClient`'s MAX_PAGES) rather than inventing shapes. One migration (0033) adds `usage_log_request_id` so a re-generate re-spend is ledgered instead of dedup-swallowed.

**Tech Stack:** Same as the delivery PRs (TypeScript ESM, Drizzle, BullMQ 5, vitest + testcontainers, prom-client).

## Global Constraints

- Branch `chore/delivery-preflip-hardening` (exists, from `cd68eb4`). Commit format `<type>(<scope>): <description>` — NO Co-Authored-By trailer.
- **Feature stays dark.** No task changes default behavior with `ENABLE_GITHUB_DELIVERY=false`.
- Every error string that reaches a DB column or a log goes through `safeErrorMessage` (`@caliber/gateway-core`) — the PAT must never appear.
- `LoggerLike` is re-declared locally per file (repo precedent — `runDeliveryEval.ts:48`, `runDeliveryQuality.ts:59-64`, `interval.ts`); there is no shared logger module. Shape: `{ info(obj, msg?): void; warn(obj, msg?): void; error(obj, msg?): void }` (copy the exact shape from the file you're editing's sibling).
- Migration rules: hand-written `NNNN_<slug>.sql` + paired `NNNN_down.sql` + one `meta/_journal.json` entry. Latest is 0032 (`when: 1783699000003`) → new one is **0033**, `when: 1783699000004`, `tag: "0033_llm_usage_request_id"`. Statements separated by `--> statement-breakpoint`. No snapshot file.
- `noUncheckedIndexedAccess` is on — `!` assertions in tests where forced.
- Integration tests spin their own testcontainers; Docker must be running. Under machine load, mass file-level failures = environment, not code (re-run the file in isolation to confirm).

---

### Task 1: `syncOrg` decrypt-failure visibility (#270 item ②)

**Files:**
- Modify: `apps/gateway/src/workers/githubSync/syncOrg.ts`
- Modify: `apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts` (forward its logger)
- Test: `apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts` (extend)

**Interfaces:**
- Produces: `SyncOrgInput` gains `logger?: LoggerLike`. `SyncOrgResult.status` can now be `"sync_error"` from a decrypt failure. No signature breaks (logger optional).

**The gap:** `decryptCredential` sits at `syncOrg.ts:74-78`, outside the try that starts at :109; the connection-row update is at :158-167. A wrong/rotated `CREDENTIAL_ENCRYPTION_KEY` throws past the update → the row keeps `status='ok'` with a stale `lastSyncAt` and the operator sees nothing.

- [ ] **Step 1 (RED):** In `syncOrg.integration.test.ts`, add:

```ts
it("persists sync_error when the sealed PAT cannot be decrypted", async () => {
  const org = await insertOrg(db);
  // Seal with a DIFFERENT master key than the one syncOrg is given.
  await insertConnection(db, org.id, {}, "cd".repeat(32));
  const warnCalls: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  const logger = {
    info: () => {},
    warn: (obj: Record<string, unknown>, msg?: string) => void warnCalls.push({ obj, msg }),
    error: () => {},
  };
  const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, logger });
  expect(res.status).toBe("sync_error");
  expect(res.errors[0]).toContain("credential");
  const conn = (await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0]!;
  expect(conn.status).toBe("sync_error");
  expect(conn.lastSyncError).not.toBeNull();
  expect(conn.lastSyncError).not.toContain(TOKEN);
  expect(conn.lastSyncAt).not.toBeNull();
  expect(warnCalls).toHaveLength(1);
  expect(warnCalls[0]!.msg).toContain("credential");
});
```

`insertConnection` currently hardcodes `MASTER_KEY`; add an optional 4th param `sealKeyHex: string = MASTER_KEY` and pass it to `encryptCredential`. Run `pnpm --filter @caliber/gateway test:integration syncOrg` → FAIL (the call throws instead of returning).

- [ ] **Step 2 (GREEN):** In `syncOrg.ts`: add `logger?: LoggerLike` to `SyncOrgInput` (declare `LoggerLike` locally above it, same shape as `interval.ts`'s). Wrap the decrypt + client construction:

```ts
  let token: string;
  try {
    token = decryptCredential({
      masterKeyHex,
      accountId: conn.id,
      sealed: { nonce: conn.nonce, ciphertext: conn.ciphertext, authTag: conn.authTag },
    });
  } catch (err) {
    // A wrong/rotated CREDENTIAL_ENCRYPTION_KEY throws here, before the sync's
    // own try/catch. Without this branch the throw escapes past the status
    // update below and the row keeps a stale status='ok' — the operator sees a
    // healthy connection while nothing syncs (#270).
    const message = `credential decrypt failed: ${safeErrorMessage(err)}`;
    input.logger?.warn({ orgId, err: safeErrorMessage(err) }, "github sync: credential decrypt failed");
    await db
      .update(githubConnections)
      .set({
        status: "sync_error",
        lastSyncAt: new Date(),
        lastSyncError: message.slice(0, MAX_ERROR_CHARS),
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, conn.id));
    return { ...emptyResult(), status: "sync_error", errors: [message] };
  }
  const client = createGithubClient({ token, fetchImpl });
```

In `runDeliveryEval.ts:113-118`, add `logger: input.logger` to the `syncOrg({...})` call.

- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration syncOrg githubDelivery/runDeliveryEval` → green; `pnpm --filter @caliber/gateway typecheck` → exit 0.
- [ ] **Step 4:** Commit: `fix(gateway): surface credential-decrypt failures on the connection row`

---

### Task 2: Projects GraphQL caps + null logging (#270 item ③)

**Files:**
- Modify: `apps/gateway/src/workers/githubSync/syncProjects.ts`
- Modify: `apps/gateway/src/workers/githubSync/syncOrg.ts` (pass logger through)
- Test: `apps/gateway/tests/workers/githubSync/syncProjects.integration.test.ts` (extend)

**Interfaces:**
- Produces: `SyncOrgProjectsInput` gains `logger?: LoggerLike`; exports `PROJECTS_MAX_PAGES = 50` and `PROJECT_ITEMS_MAX_PAGES = 50`. Return shape unchanged (`{ projectItems: number }`).

**The gaps** (`syncProjects.ts`): both do-while loops are unbounded (a server returning `hasNextPage: true` with a non-advancing cursor loops forever), and both null short-circuits (`if (!conn) break` :94-95, `if (!items) break` :104-105) are silent — a PAT lacking "Projects: read" looks identical to "zero projects" and quietly under-counts the score.

- [ ] **Step 1 (RED):** add two tests:

```ts
it("caps runaway project pagination and logs it", async () => {
  const org = await insertOrg(db);
  const warns: string[] = [];
  const logger = { info: () => {}, warn: (_o: unknown, m?: string) => void warns.push(m ?? ""), error: () => {} };
  // A server that always claims another page with the SAME cursor.
  const client = {
    ...throwingClientStub(),
    graphql: async <T,>(query: string): Promise<T> =>
      (query.includes("projectsV2(")
        ? { organization: { projectsV2: { pageInfo: { hasNextPage: true, endCursor: "stuck" }, nodes: [] } } }
        : { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }) as T,
  };
  const res = await syncOrgProjects({ db, client, orgId: org.id, ownerLogin: "acme", logger });
  expect(res.projectItems).toBe(0);
  expect(warns.some((m) => m.includes("page cap"))).toBe(true);
});

it("logs when the org node comes back null (PAT likely lacks Projects: read)", async () => {
  const org = await insertOrg(db);
  const warns: string[] = [];
  const logger = { info: () => {}, warn: (_o: unknown, m?: string) => void warns.push(m ?? ""), error: () => {} };
  const client = {
    ...throwingClientStub(),
    graphql: async <T,>(): Promise<T> => ({ organization: null }) as T,
  };
  const res = await syncOrgProjects({ db, client, orgId: org.id, ownerLogin: "acme", logger });
  expect(res.projectItems).toBe(0);
  expect(warns.some((m) => m.includes("no projects connection"))).toBe(true);
});
```

Run `pnpm --filter @caliber/gateway test:integration syncProjects` → FAIL (first test hangs/times out — that IS the bug; second has no warn).

- [ ] **Step 2 (GREEN):** in `syncProjects.ts`:
  - Add the constants with a comment citing `githubClient.ts:117-119`'s precedent: `export const PROJECTS_MAX_PAGES = 50;` / `export const PROJECT_ITEMS_MAX_PAGES = 50;`
  - Add `logger?: LoggerLike` to `SyncOrgProjectsInput` (local `LoggerLike` declaration).
  - Outer loop: replace `do { … } while (projCursor !== null)` with a page counter — `for (let page = 0; page < PROJECTS_MAX_PAGES; page++) { … if (projCursor === null) break; }` and after the loop, if `projCursor !== null`, `logger?.warn({ orgId, ownerLogin, cap: PROJECTS_MAX_PAGES }, "github projects: hit the project page cap; later projects skipped")`. (Keep the existing `if (!conn) break` but add the warn below.)
  - Null branch: `if (!conn) { logger?.warn({ orgId, ownerLogin }, "github projects: no projects connection returned (token may lack Projects: read)"); break; }`
  - Inner loop: same counter shape with `PROJECT_ITEMS_MAX_PAGES`; on cap `logger?.warn({ orgId, projectId: project.id, cap: PROJECT_ITEMS_MAX_PAGES }, "github projects: hit the item page cap; later items skipped")`; on `!items` → `logger?.warn({ orgId, projectId: project.id }, "github projects: no items connection returned")`.
  - In `syncOrg.ts`, pass `logger: input.logger` into the `syncOrgProjects({...})` call.
- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration syncProjects syncOrg` → green; typecheck exit 0.
- [ ] **Step 4:** Commit: `fix(gateway): cap Projects v2 pagination and log silent null pages`

---

### Task 3: Prompt char caps (#270 item ⑤)

**Files:**
- Modify: `packages/evaluator/src/delivery/qualityPrompt.ts`
- Modify: `apps/gateway/src/workers/githubDelivery/runDeliveryQuality.ts:210` (use the exported constant instead of a hardcoded 20)
- Test: `packages/evaluator/tests/delivery/qualityPrompt.test.ts` (extend)

**Interfaces:**
- Produces: `export const MAX_REVIEW_COMMENTS = 20` (was private), `export const PR_BODY_MAX_CHARS = 4_000`, `export const REVIEW_COMMENT_MAX_CHARS = 1_000`, `export const PR_TITLE_MAX_CHARS = 300`. Body/comments/title truncated with the `truncateDiff` marker idiom.

**The gap:** only a *count* cap exists (`MAX_REVIEW_COMMENTS`, `qualityPrompt.ts:34,75`). `pr.body` (:80) and each comment (:83) are interpolated whole — GitHub allows 65k chars each, so one fat PR body overflows the model's context → upstream 400 → transport rethrow → BullMQ retries burning LLM calls.

- [ ] **Step 1 (RED):**

```ts
it("caps an oversized PR body, comment and title with a visible marker", () => {
  const { user } = buildDeliveryQualityPrompt({
    windowDays: 30, quantTotal: 88, sectionSummary: [],
    prs: [{
      repoFullName: "acme/web", number: 1,
      title: "T".repeat(PR_TITLE_MAX_CHARS + 50),
      body: "B".repeat(PR_BODY_MAX_CHARS + 5_000),
      diff: "diff --git a/x b/x",
      reviewComments: ["C".repeat(REVIEW_COMMENT_MAX_CHARS + 500), "short one"],
    }],
  });
  expect(user).not.toContain("B".repeat(PR_BODY_MAX_CHARS + 1));
  expect(user).not.toContain("C".repeat(REVIEW_COMMENT_MAX_CHARS + 1));
  expect(user).not.toContain("T".repeat(PR_TITLE_MAX_CHARS + 1));
  expect(user).toContain("…[truncated]");
  expect(user).toContain("short one"); // untouched sibling
});

it("leaves under-cap content byte-identical", () => {
  const { user } = buildDeliveryQualityPrompt({
    windowDays: 30, quantTotal: 88, sectionSummary: [],
    prs: [{ repoFullName: "acme/web", number: 1, title: "fix: thing", body: "short body",
            diff: "diff --git a/x b/x", reviewComments: ["nice"] }],
  });
  expect(user).toContain("short body");
  expect(user).toContain("nice");
  expect(user).not.toContain("…[truncated]");
});

it("caps the comment COUNT at MAX_REVIEW_COMMENTS", () => {
  const { user } = buildDeliveryQualityPrompt({
    windowDays: 30, quantTotal: 88, sectionSummary: [],
    prs: [{ repoFullName: "acme/web", number: 1, title: "t", body: null, diff: "d",
            reviewComments: Array.from({ length: MAX_REVIEW_COMMENTS + 5 }, (_, i) => `comment-${i}`) }],
  });
  expect(user).toContain(`comment-${MAX_REVIEW_COMMENTS - 1}`);
  expect(user).not.toContain(`comment-${MAX_REVIEW_COMMENTS}`);
});
```

Run `pnpm --filter @caliber/evaluator test delivery/qualityPrompt` → FAIL (constants not exported; no truncation).

- [ ] **Step 2 (GREEN):** in `qualityPrompt.ts`, export the four constants and add a tiny local helper (mirroring `truncateDiff.ts`'s marker style — do NOT import truncateDiff, this is plain text not a diff):

```ts
const TRUNCATED_MARKER = "\n…[truncated]\n";

/** Cap free-form GitHub/LLM-adjacent text. Never throws; marker is visible to the model. */
function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + TRUNCATED_MARKER;
}
```

Apply in `formatPr`: `capText(pr.title, PR_TITLE_MAX_CHARS)`, `capText(pr.body ?? "(no description)", PR_BODY_MAX_CHARS)`, and `comments.map((c) => `- ${capText(c, REVIEW_COMMENT_MAX_CHARS)}`)`. In `runDeliveryQuality.ts:210`, import `MAX_REVIEW_COMMENTS` from `@caliber/evaluator` and use it instead of the literal `20` (single source of truth).

- [ ] **Step 3:** `pnpm --filter @caliber/evaluator test delivery` + `pnpm --filter @caliber/gateway typecheck` → green.
- [ ] **Step 4:** Commit: `feat(evaluator): cap PR body/title/comment length in the quality prompt`

---

### Task 4: Ledger dedup by `usage_log_request_id` + migration 0033 (#270 item ⑥)

**Files:**
- Create: `packages/db/drizzle/0033_llm_usage_request_id.sql`, `packages/db/drizzle/0033_down.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append `idx: 33`, `when: 1783699000004`, `tag: "0033_llm_usage_request_id"`, `breakpoints: true`)
- Modify: `packages/db/src/schema/llmUsageEvents.ts` (new column)
- Modify: `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts` (persist + dedup on it)
- Modify: `apps/gateway/src/workers/evaluator/ledgerWriter.ts` (gate the metrics inc on actual insert)
- Test: `apps/api/tests/integration/migrations/0033.test.ts` (new), `apps/gateway/tests/workers/evaluator/deepAnalysisBudget.integration.test.ts` (extend — it already exercises writeDeepAnalysisLedger)

**Interfaces:**
- Produces: `llmUsageEvents.usageLogRequestId` (`text("usage_log_request_id")`, nullable); new partial unique index `llm_usage_request_dedup_idx` on `(usage_log_request_id)` where not null; `writeDeepAnalysisLedger` persists `usageLogRequestId` and dedups on it (the old `(ref_type, ref_id, event_type)` index STAYS — it still guards the legacy rows and the facet writer).

**The gap:** the request id is used only as a `usage_logs` lookup key (`ledgerDeepAnalysis.ts:229`) and never persisted. Dedup is on `(ref_type, ref_id, event_type)` with a **stable reportId**, so a manual regenerate re-spends LLM money but writes no second ledger row → `getMonthSpend` under-counts and budget enforcement goes blind. Keying on the request id makes each real upstream call its own ledger row while still deduping BullMQ retries of the *same* call.

- [ ] **Step 1 (RED):** write `apps/api/tests/integration/migrations/0033.test.ts` (model `0032.test.ts`'s shape — `setupTestDb()`, `sql` probes, and a down-migration case reading `0033_down.sql`):

```ts
it("adds usage_log_request_id and its partial unique index", async () => {
  const cols = await t.db.execute(sql`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'llm_usage_events' AND column_name = 'usage_log_request_id'`);
  expect(cols.rows).toHaveLength(1);
  expect(cols.rows[0]!.is_nullable).toBe("YES");
  const idx = await t.db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'llm_usage_events'`);
  const names = idx.rows.map((r) => r.indexname);
  expect(names).toContain("llm_usage_request_dedup_idx");
  expect(names).toContain("llm_usage_dedup_idx"); // legacy index survives
});

it("the new index dedups by request id and tolerates NULLs", async () => {
  const org = await makeOrg(t.db);
  const row = (rid: string | null) => ({
    orgId: org.id, eventType: "deep_analysis", model: "m",
    tokensInput: 1, tokensOutput: 1, costUsd: "0.001", usageLogRequestId: rid,
  });
  await t.db.insert(llmUsageEvents).values(row("req-1"));
  await expect(t.db.insert(llmUsageEvents).values(row("req-1"))).rejects.toThrow();
  // NULLs are exempt (legacy/facet rows)
  await t.db.insert(llmUsageEvents).values(row(null));
  await t.db.insert(llmUsageEvents).values(row(null));
});

it("down migration drops the column and its index", async () => {
  const downSql = await readFile(path.join(migrationsFolder, "0033_down.sql"), "utf8");
  await t.pool.query(downSql);
  const cols = await t.db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'llm_usage_events' AND column_name = 'usage_log_request_id'`);
  expect(cols.rows).toHaveLength(0);
});
```

Run `pnpm --filter @caliber/api test:integration 0033` → FAIL (column missing).

- [ ] **Step 2 (GREEN — migration):** `0033_llm_usage_request_id.sql`:

```sql
-- 0033_llm_usage_request_id.sql
-- Ledger dedup by the upstream call's request id (#270). The existing
-- (ref_type, ref_id, event_type) index keys on a STABLE report id, so a
-- manual regenerate re-spends LLM money but is dedup-swallowed — month-spend
-- then under-counts and the budget gate goes blind. One row per real upstream
-- call; BullMQ retries of the SAME call still dedup because they reuse the
-- same x-request-id. NULL is exempt (legacy rows + the facet writer).
ALTER TABLE "llm_usage_events" ADD COLUMN "usage_log_request_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_request_dedup_idx" ON "llm_usage_events" ("usage_log_request_id") WHERE "usage_log_request_id" IS NOT NULL;
```

`0033_down.sql`:

```sql
-- 0033_down.sql — reverse of 0033_llm_usage_request_id.sql
DROP INDEX IF EXISTS "llm_usage_request_dedup_idx";
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "usage_log_request_id";
```

Append the journal entry. In `packages/db/src/schema/llmUsageEvents.ts` add the column after `refId` (with a JSDoc line citing 0033 + the dedup rationale) and the index in the table's second arg:

```ts
  /** v3 (0033): the upstream call's x-request-id — one ledger row per real call. */
  usageLogRequestId: text("usage_log_request_id"),
```

(The partial unique index is created by the migration; declare it in the schema only if the file's existing indexes are all plain — match what's there. If `uniqueIndex(...).where(...)` is already used in this repo's schemas, mirror that; otherwise leave it migration-only and note it.)

- [ ] **Step 3 (GREEN — writers):** in `ledgerDeepAnalysis.ts`'s insert (:255-277): add `usageLogRequestId: input.usageLogRequestId` to `.values({...})` and switch the conflict target to the request-id index:

```ts
      .onConflictDoNothing({
        target: llmUsageEvents.usageLogRequestId,
        where: sql`${llmUsageEvents.usageLogRequestId} IS NOT NULL`,
      })
```

In `ledgerWriter.ts:72-79`, gate the metrics increment on an actual insert (add `.returning({ id: llmUsageEvents.id })` to the insert and only `inc` when `inserted.length > 0`) — today a deduped no-op still increments `gwLlmCostUsdTotal`, double-counting on every BullMQ retry. Mirror `writeDeepAnalysisLedger`'s `written` gate.

- [ ] **Step 4:** `pnpm --filter @caliber/api test:integration 0033` + `pnpm --filter @caliber/gateway test:integration deepAnalysisBudget runDeliveryQuality` + `pnpm --filter @caliber/db typecheck` → green.
- [ ] **Step 5:** Commit: `fix(db,gateway): ledger dedup by usage_log_request_id (migration 0033)`

---

### Task 5: Budget metrics/webhook parity for delivery (#270 item ④)

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts` (`deepAnalysisBudgetGate` — fix the metrics-conditional bug)
- Modify: `apps/gateway/src/workers/githubDelivery/runDeliveryQuality.ts` (use the gate; thread metrics)
- Modify: `apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts`, `worker.ts`, `apps/gateway/src/server.ts` (threading)
- Test: `apps/gateway/tests/workers/githubDelivery/runDeliveryQuality.integration.test.ts` (extend)

**Interfaces:**
- Produces: `RunDeliveryQualityInput` + `RunDeliveryEvalInput` + `CreateGithubDeliveryWorkerOptions` each gain `metrics?: BudgetGateMetrics & Pick<GatewayMetrics, "gwLlmCostUsdTotal">` and `onBudgetEvent?: (e: BudgetAlertEvent) => void`. `deepAnalysisBudgetGate` fires `onBudgetEvent` even when `metrics` is absent.

**Two gaps:** (a) `runDeliveryQuality.ts:130` calls bare `enforceBudget` — a delivery budget denial increments no counter and fires no webhook, so the operator is blind exactly when spend is being refused; (b) `deepAnalysisBudgetGate:133-135` only wires `wrapEnforceBudget` when `input.metrics` is truthy, so an `onBudgetEvent` passed without metrics is **silently dropped** — a latent bug in the evaluator path too.

- [ ] **Step 1 (RED):**

```ts
it("budget denial increments the counter and fires the alert event", async () => {
  const org = await insertOrg(db, { llmEvalEnabled: true, llmEvalModel: MODEL, llmHaltedUntilMonthEnd: true });
  const events: Array<{ event: string }> = [];
  const inc = vi.fn();
  const res = await runDeliveryQuality({
    ...baseInput(org.id),
    metrics: { gwLlmBudgetWarnTotal: { inc }, gwLlmBudgetExceededTotal: { inc }, gwLlmCostUsdTotal: { inc } } as never,
    onBudgetEvent: (e) => void events.push(e),
  });
  expect(res.status).toBe("budget_denied");
  expect(inc).toHaveBeenCalled();
  expect(events.some((e) => e.event === "exceeded")).toBe(true);
});
```

Plus, in the evaluator's own suite (`deepAnalysisBudget.integration.test.ts`), a case proving the conditional-metrics bug:

```ts
it("fires onBudgetEvent even when no metrics are supplied", async () => {
  const org = await makeHaltedOrg(db);
  const events: unknown[] = [];
  const gate = await deepAnalysisBudgetGate({ db, orgId: org.id, enforce: true, onBudgetEvent: (e) => void events.push(e) });
  expect(gate.skip).toBe(true);
  expect(events).toHaveLength(1);
});
```

Run both → FAIL.

- [ ] **Step 2 (GREEN):** in `deepAnalysisBudgetGate` (:133-135), always route through `wrapEnforceBudget` when EITHER metrics or onBudgetEvent is present; make `wrapEnforceBudget`'s `metrics` param optional (`metrics?: BudgetGateMetrics`) and guard its two `.inc(...)` call sites with `?.` — `enforceBudgetWithMetrics.ts:47-54,63-78,80-106`. (Check the file: if the `.inc` sites already tolerate an absent metrics object, only the gate's ternary needs changing.)

In `runDeliveryQuality.ts:127-137`, replace the bare call with the shared gate:

```ts
  const gate = await deepAnalysisBudgetGate({
    db: input.db,
    orgId: input.orgId,
    enforce: isDeepAnalysisEnforceEnabled(),
    metrics: input.metrics,
    onBudgetEvent: input.onBudgetEvent,
  });
  if (gate.skip) return { status: "budget_denied" };
```

Also pass `metrics: input.metrics` into the existing `writeDeepAnalysisLedger` call (:284-292) so `gwLlmCostUsdTotal` records delivery spend. Thread `metrics`/`onBudgetEvent` down: `runDeliveryEval` (add to input, forward at the `runDeliveryQuality` call ~:246-261) → `createGithubDeliveryWorker` opts → `server.ts`. In `server.ts`, the `onBudgetEvent` closure is currently built inside `wireEvaluatorPipeline` (:641) over `workerRedis`; **hoist it** to module/function scope so `wireGithubSyncPipeline` (:753-760) can pass the same closure plus `metrics: app.gwMetrics` to `createGithubDeliveryWorker`. If hoisting fights the current structure, build a second identical closure over `githubRedis` in `wireGithubSyncPipeline` and note it (the dedup keys live in Redis, so either connection is fine).

- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration githubDelivery/runDeliveryQuality deepAnalysisBudget runEvaluation` + typecheck → green (the evaluator path must not regress).
- [ ] **Step 4:** Commit: `fix(gateway): budget denials on the delivery path emit metrics and alerts`

---

### Task 6: evaluator cron coalescing port (#270 item ⑦)

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/cron.ts:256-300` (`startEvaluatorCron`)
- Test: `apps/gateway/tests/workers/evaluator/cron.integration.test.ts` (extend — first-ever `startEvaluatorCron` coverage)

**Interfaces:**
- Produces: no signature change. `EvaluatorCronHandle.tick()` now JOINS an in-flight pass instead of awaiting it and then running a second one.

**The gap:** `cron.ts:295-298`'s `tick: async () => { await currentTick; await runTick(); }` always runs an extra independent pass; `currentTick` is never cleared on settle. `githubSync/interval.ts:70-98` is the fixed shape (identity/epoch-guarded `scheduleTick`, `tick: () => currentTick ?? scheduleTick()`). Only BullMQ's jobId dedup saves it from real duplicate jobs — the counters and DB enumeration still double.

- [ ] **Step 1 (RED):** the file's existing tests only call `enqueueDailyEvaluatorJobs` directly. Add a `describe("startEvaluatorCron")` block modeled on `githubSync/interval.integration.test.ts:107-138` (note its comment: `stop()` must come AFTER `tick()`):

```ts
it("tick joins the in-flight start-up pass instead of running a second one", async () => {
  const org = await makeOrgWithMembers(db); // reuse whatever the file's existing cases use to seed
  const added: unknown[] = [];
  const queue = { add: async (...a: unknown[]) => void added.push(a) };
  const noopLogger = { info: () => {}, error: () => {} };
  const handle = startEvaluatorCron({ db, queue, logger: noopLogger, intervalMs: 60 * 60 * 1000 });
  // Do NOT clear `added` — the point is that the start-up tick and this tick()
  // are ONE pass, so the enqueue count must equal a single pass's worth.
  await handle.tick();
  handle.stop();
  const singlePass = await countExpectedJobs(db); // or hardcode the seeded member count
  expect(added).toHaveLength(singlePass);
});
```

Run `pnpm --filter @caliber/gateway test:integration evaluator/cron` → FAIL (`added` has 2× the jobs).

- [ ] **Step 2 (GREEN):** port `interval.ts`'s shape into `startEvaluatorCron`, keeping `runTick`'s existing self-catch (do NOT double-catch — `interval.ts` catches in `scheduleTick` because its `tick()` doesn't self-catch; `cron.ts`'s `runTick` already does):

```ts
  let currentTick: Promise<void> | null = null;

  // Tracks the in-flight tick so a manual `handle.tick()` joins an already-
  // running pass (e.g. the run-at-start tick) instead of racing it with a
  // second, independent DB enumeration + duplicate enqueues. Cleared back to
  // null once the pass settles so the next call starts a fresh one. Ported
  // from githubSync/interval.ts, which fixed this same bug (#270).
  function scheduleTick(): Promise<void> {
    const settled = runTick().finally(() => {
      if (currentTick === settled) currentTick = null;
    });
    currentTick = settled;
    return settled;
  }

  currentTick = scheduleTick();
  const timer = setInterval(() => { scheduleTick(); }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    tick: () => currentTick ?? scheduleTick(),
  };
```

- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration evaluator/cron perKeyCron` + typecheck → green.
- [ ] **Step 4:** Commit: `fix(gateway): coalesce evaluator cron ticks (port the interval.ts fix)`

---

### Task 7: The two deferred edge-case tests (#270 item ⑧)

**Files:**
- Test: `apps/api/tests/integration/trpc/githubDelivery.test.ts` (extend — salt-race self-heal)
- Test: `apps/api/tests/server.onClose.test.ts` (new — quit-exactly-once; FIRST test of apps/api's server builder)

**Interfaces:** none (test-only task).

**(a) Salt-race self-heal** — `githubDelivery.ts:163-177`'s `persistedId !== id` branch has no test. It fires when two concurrent `setConnection` calls for the same fresh org each mint their own `randomUUID()`: the loser's `ON CONFLICT DO UPDATE` writes ciphertext sealed under its own id while the row keeps the winner's id, so it re-seals with `persistedId`.

- [ ] **Step 1:** add:

```ts
it("concurrent first-writes leave a row whose ciphertext decrypts with its own id", async () => {
  stubProbeFetch(true);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });

  // Two concurrent first-writes for the same org: each computes its own
  // randomUUID() salt before either row exists.
  await Promise.all([
    caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN }),
    caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: `${TOKEN}B` }),
  ]);

  const rows = await t.db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id));
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  // The invariant: whatever ciphertext survived must decrypt with the row's OWN id.
  const plaintext = decryptCredential({
    masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
    accountId: row.id,
    sealed: { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag },
  });
  expect([TOKEN, `${TOKEN}B`]).toContain(plaintext);
  expect(row.tokenLast4).toBe(plaintext.slice(-4));
});
```

Import `decryptCredential` from `@caliber/gateway-core` and `githubConnections` from `@caliber/db`. Note: this test passes today (the self-heal works) — it is a REGRESSION PIN, not a bug hunt. If it fails, the self-heal is broken and that IS the finding.

**(b) Quit-exactly-once** — `server.ts:217-232`'s consolidated hook. There is NO existing apps/api server-level test (`health.test.ts` builds a bare Fastify and registers routes in isolation). This is a unit test under `apps/api/vitest.config.ts` (which excludes `tests/integration/**`) using `vi.mock` for ioredis + the queue factories — do NOT boot Postgres.

- [ ] **Step 2:** write `apps/api/tests/server.onClose.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const quit = vi.fn().mockResolvedValue("OK");
const evaluatorClose = vi.fn().mockResolvedValue(undefined);
const syncClose = vi.fn().mockResolvedValue(undefined);
const deliveryClose = vi.fn().mockResolvedValue(undefined);
const redisCtor = vi.fn(() => ({ quit, on: vi.fn() }));

vi.mock("ioredis", () => ({ Redis: redisCtor, default: redisCtor }));
vi.mock("@caliber/queue", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createEvaluatorQueue: vi.fn(() => ({ close: evaluatorClose })),
  createGithubSyncQueue: vi.fn(() => ({ close: syncClose })),
  createGithubDeliveryQueue: vi.fn(() => ({ close: deliveryClose })),
}));

// buildServer's real import path — READ apps/api/src/server.ts's exports first
// and import whatever the app-builder factory is actually called.
```

Then three cases (evaluator-only / delivery-only / both) asserting: exactly ONE `redisCtor` call when both flags are on (the connection is reused), `quit` called exactly once on `app.close()`, and close-before-quit ordering (`expect(evaluatorClose.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0])`).

**If `server.ts` has no exported builder** (i.e. it only self-boots on import), do NOT refactor it in this task — instead report that in your report and cover the invariant the cheap way: assert the source's structure is a single `addHook("onClose")` guarded by `if (bullmqRedis)` via a focused regex over the file, and note the limitation. A structural test is weak but honest; refactoring the server boot is out of scope for a hardening PR.

- [ ] **Step 3:** `pnpm --filter @caliber/api test:integration githubDelivery` + `pnpm --filter @caliber/api test server.onClose` → green.
- [ ] **Step 4:** Commit: `test(api): pin the salt-race self-heal and the quit-once shutdown`

---

### Task 8: Full verification + PR

- [ ] **Step 1:** `pnpm turbo run lint typecheck test` (42 tasks) → green.
- [ ] **Step 2:** `node scripts/audit-zod-i18n.mjs > /tmp/audit.tsv && awk -F'\t' '$3=="template"' /tmp/audit.tsv` → NO output (this is ci.yml's standalone audit; turbo does NOT run it — it red-gated main for two days).
- [ ] **Step 3:** `pnpm --filter @caliber/gateway test:integration` and `pnpm --filter @caliber/api test:integration` → green (under load, re-run a failing file in isolation before believing it).
- [ ] **Step 4:** Push (gh account gotcha: `gh auth switch --user hanfour && gh auth setup-git` first) + PR. Body notes: closes the whole of #270 (list each item + its commit), the two bonus bugs found while in there (`deepAnalysisBudgetGate`'s dropped `onBudgetEvent`, `ledgerWriter`'s ungated metrics inc), migration 0033 (operator upgrade: applies on next deploy, additive nullable column + partial index, no backfill), feature still dark. **Use `Closes #270`** — this PR really does close it.
- [ ] **Step 5:** Final whole-branch review (fable) before merge, per the previous PRs.

## Coverage / deviation notes

- #270's item ① (rate-limit `resetAtMs`) was already delivered in PR #269's review-response wave (`moveToDelayed` + `DelayedError` + `computeRateLimitDelayMs`) — its checkbox was never ticked. Task 8's PR body should tick it with that commit reference rather than re-doing it.
- #270's last item (>5000-PR first sync truncates at the pagination cap) is a documented limit with no action, per the issue's own text.
- Two bugs found during recon, folded in because they are one-line neighbours of the work: `deepAnalysisBudgetGate` drops `onBudgetEvent` when `metrics` is absent (Task 5); `createLedgerWriter` increments `gwLlmCostUsdTotal` even when the insert deduped to a no-op (Task 4).
- The PR4-era UI items (hide-on-NOT_FOUND, click-sort, unhandled-rejection sweep) and PR3's minor batch (double cost-poll, `listReviewComments` full pagination, manual-generate `auth_error` pre-check) are NOT in this plan — they are post-flip polish, not flip blockers. They stay on #270's comment thread; the PR body should say so explicitly so closing #270 doesn't silently drop them (re-file as a fresh issue if the thread would be lost).
