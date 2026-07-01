# Per-Project (Per-Key) Custom Rubric — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each project (`api_key`) author its own scoring rubric; a per-key evaluation resolves rubric key → org → platform, with the per-person path unchanged.

**Architecture:** Add a nullable `rubrics.api_key_id` scope to the existing `rubrics` table (reusing `definition` jsonb + `rubricSchema` + `RubricEditor`). `rubricResolver` gains an optional `apiKeyId` and a precedence chain. New `rubric.*_key` RBAC actions (owner-self OR org_admin) + `getForKey/upsertForKey/deleteForKey` procedures. Every existing org rubric read/write filters out key rubrics so they can never leak into the org surface or be pinned org-active.

**Tech Stack:** TypeScript, tRPC, drizzle-orm + Postgres 16, BullMQ workers (apps/gateway), Next.js + next-intl (apps/web), vitest + @testcontainers/postgresql.

**Spec:** `docs/superpowers/specs/2026-07-01-per-project-rubric-design.md` (read fully first).

## Global Constraints

- **Storage = nullable `rubrics.api_key_id` scope.** NEVER add `api_keys.rubric_id`. A key rubric is exactly `{ orgId: key.orgId, apiKeyId: key.id, isDefault: false }`.
- **Resolver precedence:** key → org → platform. The org branch AND the platform branch MUST add `isNull(rubrics.apiKeyId)`. Per-person jobs pass no `apiKeyId` → branch 0 skipped → **byte-identical** DB queries + result (existing resolver test stays green, incl. `fromOrgCustom`).
- **Leak scoping (crown jewel):** add `isNull(rubrics.apiKeyId)` to ALL SIX org rubric procedures — `list`, `get`, `update`, `delete`, `dryRun` (→ NOT_FOUND for a key rubric), and `setActive` (reject `apiKeyId != null`). ALSO make `contentCapture.setSettings` reject a `patch.rubricId` that points to a key rubric.
- **RBAC:** 3 new actions `rubric.read_key` / `rubric.author_key` / `rubric.delete_key`, each `{ apiKeyId, orgId, ownerUserId }`, allowed for `ownerUserId === perm.userId` OR org_admin-of-orgId (super_admin already short-circuits). CANNOT reuse `rubric.create/update/delete` (org_admin-only).
- **Anti-enumeration:** key-scoped procedures resolve the key by id and throw **NOT_FOUND** on missing OR revoked OR caller-not-(owner|org_admin) — never FORBIDDEN. `author_key` also rejects a revoked key.
- **Server-forced fields on upsert:** `apiKeyId=key.id`, `orgId=key.orgId`, `isDefault=false`, `createdBy=ctx.user.id` (insert). `definition` validated with `rubricSchema.safeParse` → BAD_REQUEST. Soft-delete on `deleteForKey`. Audit rows (`rubric.key_set` / `rubric.key_cleared`, targetType `api_key`).
- **New key-scoped procedures call `ensureGatewayEnabled(ctx.env)` first** (match `setEvaluateAsProject`).
- **GDPR:** `reports.exportOwn` includes the caller's authored key rubrics (`created_by = caller AND api_key_id IS NOT NULL AND deleted_at IS NULL`); erasure KEEPS key rubrics (project config).
- **i18n:** any new web key added to all five `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` in the same commit + a catalog-parity test.
- **UI gate:** entry points enabled only when `row.evaluateAsProject === true` AND behind `ENABLE_PROJECT_EVALUATION` (same mechanism the toggle uses).
- TDD every behavioral change; commit per task. Migration: use the **next free** drizzle number (verify `ls packages/db/drizzle/`); watch the journal `when` caveat (verify applied post-deploy).

## File structure

**Modify**
- `packages/db/src/schema/rubrics.ts` (+ generated migration up/down)
- `apps/gateway/src/workers/evaluator/rubricResolver.ts`, `worker.ts`
- `packages/auth/src/rbac/actions.ts`, `check.ts`
- `apps/api/src/trpc/routers/rubrics.ts`, `contentCapture.ts`, `reports.ts`
- `apps/web/src/components/evaluator/RubricEditor.tsx`, `ProjectScoreSection.tsx`
- `apps/web/src/components/apiKeys/ApiKeyList.tsx`, `AdminApiKeyList.tsx`
- `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`

---

## Task 1 (PR1): DB — `rubrics.api_key_id` scope + partial unique + CHECK

**Files:**
- Modify: `packages/db/src/schema/rubrics.ts`
- Create: `packages/db/drizzle/00NN_*.sql` (next free number) + hand-authored down
- Test: `apps/api/tests/integration/migrations/00NN.test.ts`

**Interfaces:**
- Produces: `rubrics.apiKeyId: uuid | null` (FK `api_keys.id` ON DELETE CASCADE); partial unique `(api_key_id) WHERE api_key_id IS NOT NULL AND deleted_at IS NULL`; CHECK `api_key_id IS NULL OR (org_id IS NOT NULL AND is_default = false)`.

- [ ] **Step 1: Read** `packages/db/src/schema/rubrics.ts` (full column set, `rubrics_org_idx`, `rubrics_default_idx`, `createdBy` onDelete), `apiKeys.ts` (for the FK target), and how `0022_llm_usage_events_dedup.sql` hand-authored a partial index + journaled it. Note the latest migration number in `packages/db/drizzle/`.

- [ ] **Step 2: Failing migration test** `00NN.test.ts` (testcontainers):
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../factories/index.js";
let t: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.stop(); });
describe("rubrics.api_key_id scope", () => {
  it("column + FK + partial-unique + CHECK exist", async () => {
    const col = await t.db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='rubrics' AND column_name='api_key_id'`);
    expect(col.rows[0]).toMatchObject({ is_nullable: "YES" });
    const idx = await t.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='rubrics' AND indexname='rubrics_api_key_uniq'`);
    expect(idx.rows).toHaveLength(1);
    expect(String(idx.rows[0]!.indexdef)).toMatch(/WHERE.*api_key_id IS NOT NULL.*deleted_at IS NULL/i);
    const chk = await t.db.execute(sql`SELECT conname FROM pg_constraint WHERE conname='rubrics_key_scope_chk'`);
    expect(chk.rows).toHaveLength(1);
  });
  it("CHECK rejects is_default=true or org_id NULL when api_key_id set; unique rejects 2nd live per key", async () => {
    // seed an org + a user + an api_key first (use factories); then:
    // INSERT a valid key rubric → OK; a 2nd live one for same key → unique violation;
    // INSERT with api_key_id set + is_default true → CHECK violation; + org_id NULL → CHECK violation.
    // (Author these with t.pool.query and expect rejects.)
  });
});
```

- [ ] **Step 3: Run → FAIL.** `pnpm --filter @caliber/api exec vitest run --config vitest.integration.config.ts migrations/00NN --maxWorkers=2`

- [ ] **Step 4: Schema edit** `rubrics.ts`: add `apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" })`; add the partial unique index (`.on(t.apiKeyId).where(sql\`api_key_id IS NOT NULL AND deleted_at IS NULL\`)`) and the CHECK constraint (drizzle `check("rubrics_key_scope_chk", sql\`...\`)`). Keep existing indexes.

- [ ] **Step 5: Generate + hand-author.** `pnpm --filter @caliber/db db:generate`. drizzle may not emit the partial-index `WHERE` or the CHECK exactly — verify the generated `.sql` matches the spec §2 SQL; hand-fix the partial `WHERE` + CHECK if needed; write the down migration; journal it like `0022`.

- [ ] **Step 6: Run → PASS.** Same command as Step 3.

- [ ] **Step 7: Cascade test.** Extend the test: seed org+user+key+key-rubric; hard-`DELETE FROM api_keys WHERE id=key` → the key rubric is gone (CASCADE); `DELETE FROM organizations` → gone. Existing org/platform rubric inserts + a `rubrics` list still work. Run → PASS.

- [ ] **Step 8: typecheck + commit.** `pnpm --filter @caliber/db typecheck` → `git commit -m "feat(db): rubrics.api_key_id key-scope + partial unique + CHECK"`

---

## Task 2 (PR2): rubricResolver — precedence + signature (per-person byte-identical)

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/rubricResolver.ts`
- Test: the existing resolver test file + new cases

**Interfaces:**
- Consumes: Task 1 column.
- Produces: `ResolveRubricInput { db, orgId, apiKeyId?, locale? }`; `ResolvedRubric { rubric, rubricId, rubricVersion, fromOrgCustom, source: "key"|"org"|"platform" }`.

- [ ] **Step 1: Read** `rubricResolver.ts` fully (the org-branch load ~line 111, the platform branch, the cache impl + `invalidate`, the existing `ResolvedRubric` shape + its test).

- [ ] **Step 2: Failing tests** (unit): (a) snapshot the EXISTING per-person resolution (no apiKeyId) — result + `fromOrgCustom` byte-identical; (b) with a key rubric present → `source:"key"` returns it; (c) soft-deleted key rubric → falls through to org; (d) key rubric with a different orgId → ignored; (e) per-key and per-person cache entries don't collide. Run → FAIL.

- [ ] **Step 3: Implement.** Add `apiKeyId?` to the input; add branch 0 (key lookup `WHERE api_key_id = :apiKeyId AND org_id = :orgId AND deleted_at IS NULL`); add `isNull(rubrics.apiKeyId)` to the org branch AND the platform branch; add `source`; derive `fromOrgCustom = source === "org"`; namespace the cache key `${orgId}::${apiKeyId ?? ""}::${locale}`; keep `invalidate(orgId)` prefix-matching `${orgId}::`.

- [ ] **Step 4: Run → PASS** + the existing resolver suite stays green. Commit `feat(evaluator): rubricResolver key→org→platform precedence (+source, namespaced cache)`.

---

## Task 3 (PR3): Worker wiring — pass `apiKeyId` to the resolver

**Files:** Modify `apps/gateway/src/workers/evaluator/worker.ts`. Test: real-DB integration.

**Interfaces:** Consumes Task 2 resolver signature; `EvaluatorJobPayload.apiKeyId` already exists (v0.17.0).

- [ ] **Step 1: Read** `worker.ts` around the `resolver.resolve({ db, orgId })` call (it already has `payload.apiKeyId` in scope from the per-key feature).
- [ ] **Step 2: Failing test** (real-DB, mirror the byKey tests): seed org+user+key+key-rubric; run a per-key job → `evaluation_reports_by_key.rubric_id` == the key rubric's id + version; a per-key job for a key WITHOUT a key rubric → org/platform rubric id; a per-person job → unchanged. Run → FAIL.
- [ ] **Step 3: Implement** — add `apiKeyId: payload.apiKeyId` to the `resolver.resolve({...})` call (one line). Run → PASS. Commit `feat(evaluator): per-key jobs resolve the key's rubric`.

---

## Task 4 (PR4): RBAC — `rubric.read_key/author_key/delete_key`

**Files:** Modify `packages/auth/src/rbac/actions.ts`, `check.ts`. Test: auth rbac unit.

**Interfaces:** Produces the 3 actions + `can()` handling.

- [ ] **Step 1: Read** how `api_key.evaluate_as_project_set` is shaped in `actions.ts` + handled in `check.ts` (the owner-self OR org_admin grouped case + `rolesAt`); note super_admin short-circuit.
- [ ] **Step 2: Failing tests** — matrix per action: owner allowed; org_admin-of-orgId allowed; a different member denied; cross-org admin denied; super_admin allowed. Run → FAIL.
- [ ] **Step 3: Implement** — add the 3 union members (`{ apiKeyId, orgId, ownerUserId }`) + a grouped `case` in `check.ts` (`ownerUserId === perm.userId` → true; else org_admin-of-orgId). Run → PASS. Commit `feat(auth): rubric.{read,author,delete}_key actions`.

---

## Task 5 (PR5): tRPC — key rubric procedures + org-surface leak scoping

**Files:** Modify `apps/api/src/trpc/routers/rubrics.ts`, `contentCapture.ts`. Test: api integration.

**Interfaces:** Produces `rubrics.getForKey/upsertForKey/deleteForKey({ apiKeyId })`.

- [ ] **Step 1: Read** `rubrics.ts` (all six procedures list/get/update/delete/setActive/dryRun + their predicates; the `create` upsert/`rubricSchema` validate + audit pattern), `reports.ts` `assertOwnApiKey`/`resolveKeyInOrg` (the NOT_FOUND anti-enum + key resolution), `apiKeys.ts` `setEvaluateAsProject` (`ensureGatewayEnabled` + owner/org_admin), `contentCapture.ts:~124` (`setSettings` writing `rubricId`).
- [ ] **Step 2: Failing tests** (integration): owner upsert→read→delete happy path; a peer member probing `getForKey` → NOT_FOUND; cross-org admin → NOT_FOUND; `upsertForKey` cannot set `isDefault`/org scope (server-forced); `author_key` on a revoked key → NOT_FOUND; existing `list/get/update/delete/dryRun` exclude a key rubric; `setActive` on a key rubric → rejected; `contentCapture.setSettings` with `patch.rubricId` = a key rubric → FORBIDDEN; concurrent double-create → unique violation converted to update; re-author after soft-delete targets the live slot. Run → FAIL.
- [ ] **Step 3: Implement** — the 3 key procedures (`ensureGatewayEnabled`; key-first NOT_FOUND anti-enum; `rubricSchema.safeParse`→BAD_REQUEST; server-forced fields; ON CONFLICT on the partial-unique slot; soft-delete; audit). Add `isNull(apiKeyId)` to the six org procedures (setActive rejects `apiKeyId != null`; dryRun/get → NOT_FOUND). Add the `contentCapture.setSettings` key-rubric reject. Run → PASS + existing rubrics/reports tests green. Commit `feat(api): key rubric procedures + org-surface leak scoping`.

---

## Task 6 (PR6): Web + i18n

**Files:** Modify `RubricEditor.tsx`, `ApiKeyList.tsx`, `AdminApiKeyList.tsx`, `ProjectScoreSection.tsx`, all 5 catalogs. Test: RTL + parity.

- [ ] **Step 1: Read** `RubricEditor.tsx` (how it takes `orgId` + calls `create`/`update`/`get`), `ApiKeyList/AdminApiKeyList.tsx` (the `evaluateAsProject` toggle + owner/admin context + `useConfirm` + permission gating), `ProjectScoreSection.tsx` (per-key report + the resolver `source` if surfaced).
- [ ] **Step 2:** Refactor `RubricEditor` to a discriminated `target: {scope:"org";orgId} | {scope:"key";apiKeyId;orgId}` — key scope loads via `getForKey`, saves via `upsertForKey` (single path); org scope byte-identical (`create`/`update`). Add i18n keys `evaluator.rubrics.keyScope.*` + `apiKeys.evaluateAsProject.editRubric` to all 5 catalogs; catalog-parity test.
- [ ] **Step 3:** Entry points — "Edit rubric"/"Remove custom rubric" next to the toggle in both lists, enabled only when `row.evaluateAsProject` and gated via `usePermissions().can({type:"rubric.author_key",...})` + `ENABLE_PROJECT_EVALUATION`; a "Customize rubric" link + `source` badge in `ProjectScoreSection`. RTL tests: key mode → `upsertForKey/getForKey`; org mode → `create/update`; entry hidden when toggle/flag off. Run web typecheck + tests. Commit `feat(web): per-key rubric authoring UI + i18n`.

---

## Task 7 (PR7): GDPR + cascade hardening

**Files:** Modify `apps/api/src/trpc/routers/reports.ts` (`exportOwn`). Test: real-DB.

- [ ] **Step 1: Read** `reports.ts` `exportOwn` (the bundle it builds) + `gdprDelete.ts` (the `bodies_and_reports` deletion order).
- [ ] **Step 2: Failing tests** (real-DB): `exportOwn` includes the caller's key rubrics (`created_by=caller AND api_key_id IS NOT NULL AND deleted_at IS NULL`); a hard-delete of an api_key / org / user whose by-key reports reference the key rubric does NOT abort on `evaluation_reports_by_key.rubric_id` RESTRICT (reports removed first via the existing gdpr/org-delete order — assert no error); soft-erasure keeps the key rubric. Run → FAIL.
- [ ] **Step 3: Implement** — add the key-rubric SELECT to `exportOwn`'s bundle. (No gdprDelete change: key rubrics are project config, kept on soft-erasure — the cascade convergence is a property to TEST, not new code; if the delete-order test ever aborts, add app-side soft-delete-before-hard-delete and note it.) Run → PASS. Commit `feat(api): GDPR export covers key rubrics; document erasure semantics`.

---

## Deferred / non-blocking (final review triage)
- Optional shared `orgVisibleRubrics()` query helper as a single chokepoint for the `isNull(api_key_id)` discriminator (prevents future leak regressions).
- Cross-process cache staleness (≤5-min TTL) — same as org `setActive` today; a resolver invalidate hook is out of scope.
