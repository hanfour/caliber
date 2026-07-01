# Per-Project (Per-Key) Custom Rubric — Design Spec

- **Date:** 2026-07-01
- **Status:** Design approved (brainstorming) → ready for implementation plan
- **Builds on:** v0.17.0 per-project (per-api-key) scoring (`docs/superpowers/specs/2026-06-30-per-project-scoring-design.md`).
- **Provenance:** Decisions fixed via brainstorming with the operator; design converged by a 4-proposal × 3-judge multi-agent panel (all four lenses tied at 22.3/25) and verified against the codebase.

## Fixed decisions (operator-chosen — do not re-litigate)

1. Each api_key can **author its own custom rubric** (not merely pick one). REUSE the existing rubric infrastructure (`rubrics` table + `definition` jsonb + `rubricSchema` + `RubricEditor` + `rubricsRouter`) — a rubric becomes SCOPED to a key.
2. **RBAC:** the key OWNER (the member) OR an org_admin can author/edit a key's rubric.
3. **Resolution is optional/fallback:** for a per-key evaluation, rubric = key → org → platform. A key without a custom rubric still gets per-key reports (org/platform rubric). PER-PERSON evaluation is UNCHANGED.

---

## 0. Summary

A "project" is an `api_key`. Building on v0.17.0 per-key scoring, each key may **author its own custom rubric**, reusing the existing rubric infrastructure. Resolution for a per-key evaluation becomes **key → org → platform** (optional/fallback). The **per-person path stays byte-identical**. A key-scoped rubric can never appear in an org list, be pinned as the org/platform default, or leak across keys.

Verified corrections that shaped the design:
- `rubrics.list/get/update/delete/setActive/dryRun` — **all six** filter only on `orgId`/`isNull(orgId)`, so a key rubric carrying `orgId=key.orgId` would leak through every one.
- `organizations.rubricId` has a **second unguarded writer**: `contentCapture.setSettings` (`updates = {...input.patch}` includes `rubricId`) — the `setActive` guard alone is insufficient, so the resolver org-branch must be hardened.
- `gdprDelete` is soft erasure by `(user,org)`; it never hard-deletes users/keys, so `createdBy SET NULL` / `api_key_id CASCADE` don't fire on erasure. `reports.exportOwn` never touches the `rubrics` table.
- `worker.ts` already threads `payload.apiKeyId` into `runEvaluation`; only the `resolver.resolve(...)` call omits it — a genuine one-line change.

---

## 1. Storage decision

**Chosen: add nullable `rubrics.api_key_id` (scope-on-the-rubric).** Unanimous across all four proposals and all twelve judges.

Deciding rationale (verified against `packages/db/src/schema/rubrics.ts` and `apps/api/src/trpc/routers/rubrics.ts`):
- **Single source of scope.** Option (b) `api_keys.rubric_id` FK still needs a discriminator on `rubrics` anyway — `rubrics.list` selects `or(eq(orgId), isNull(orgId))`, so an authored row carrying `orgId=key.orgId` would surface in the org picker and be selectable as org-active regardless. (b) adds a second source of truth without removing the discriminator; (a) does the job with one column.
- **1:1 authoring ("its OWN").** A partial unique index enforces at-most-one live rubric per key. An FK-from-key (b) permits N keys → 1 row, so an edit bleeds across keys (violates cross-key isolation).
- **Cascade lives in one place.** `rubrics.api_key_id … ON DELETE CASCADE` mirrors `evaluation_reports_by_key.api_key_id` semantics (cascade fires only on key **hard**-delete; soft-revoke keeps the rubric).
- **Cycle-safe.** `organizations.rubricId` is a bare `uuid` with no FK/import, and `apiKeys` imports only `users/org/accountGroups`, so `rubrics → apiKeys` adds no import cycle (`evaluationReportsByKey` already imports both).

A key rubric is `{ orgId: key.orgId, apiKeyId: key.id, isDefault: false }`. `orgId` is denormalized (= the key's org) for tenant scoping, org-delete cascade, and RBAC.

---

## 2. Data model & migrations

New migration `0024_rubrics_api_key_scope` (use the next free number — verify latest in `packages/db/drizzle/`), grounded in the 0017_down.sql rollback convention + the drizzle journal `when` caveat (#129/0016):

```sql
-- up
ALTER TABLE rubrics
  ADD COLUMN api_key_id uuid REFERENCES api_keys(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX rubrics_api_key_uniq
  ON rubrics(api_key_id)
  WHERE api_key_id IS NOT NULL AND deleted_at IS NULL;   -- ≤1 live rubric/key; also the resolver lookup index

ALTER TABLE rubrics
  ADD CONSTRAINT rubrics_key_scope_chk
  CHECK (api_key_id IS NULL OR (org_id IS NOT NULL AND is_default = false));
```

```sql
-- down
ALTER TABLE rubrics DROP CONSTRAINT rubrics_key_scope_chk;
DROP INDEX rubrics_api_key_uniq;
ALTER TABLE rubrics DROP COLUMN api_key_id;
```

Drizzle schema: add `apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" })`, the partial unique index, and the CHECK. Keep `rubrics_org_idx` / `rubrics_default_idx` untouched. `createdBy` stays `onDelete: "set null"`.

Safe on existing rows: all have `api_key_id = NULL` → CHECK passes; no backfill. **No change** to `evaluation_reports_by_key` (its `rubric_id`/`rubric_version` already record the scorer; `rubric_id` stays `ON DELETE RESTRICT` → rubrics remain soft-delete-only for report integrity).

**Precise scope of the CHECK:** `is_default` governs only the *platform* default (`org_id IS NULL AND is_default = true`). The *org-active* rubric is `organizations.rubric_id` (a plain uuid, no FK, no CHECK). So "a key rubric can never be an org-active rubric" is enforced at the **app layer + resolver** (§3, §4), not by this CHECK.

---

## 3. rubricResolver — precedence & signature (per-person byte-identical)

File: `apps/gateway/src/workers/evaluator/rubricResolver.ts`.

**Signature.** `ResolveRubricInput` gains optional `apiKeyId?: string`. `ResolvedRubric` gains `source: "key" | "org" | "platform"` and **retains** `fromOrgCustom` (derive `= source === "org"`) so existing consumers/tests are untouched.

**Precedence (first live match wins, `isNull(deletedAt)` at every step, each miss falls through):**
0. If `apiKeyId` set → `SELECT … FROM rubrics WHERE api_key_id = :apiKeyId AND org_id = :orgId AND deleted_at IS NULL` (org equality = defense-in-depth). Hit → `source:"key"`, STOP. Miss → fall through.
1. Existing org branch via `organizations.rubric_id` — **hardened**: add `isNull(rubrics.apiKeyId)` to the load. **Required, not optional**, because `organizations.rubric_id` has two writers (`rubrics.setActive` *and* `contentCapture.setSettings`), and only the resolver filter guarantees a key rubric can never be scored org-wide (incl. the per-person path) even if a bad pointer is written.
2. Existing platform-default branch (`isNull(orgId) AND isDefault`) — add `isNull(rubrics.apiKeyId)` too (cheap; already safe since key rubrics have `orgId` set).

**Cache.** `cacheKey`: `${orgId}::${locale}` → `${orgId}::${apiKeyId ?? ""}::${locale}` so per-key and per-person entries never collide. `invalidate(orgId)` still prefix-matches `${orgId}::`.

**Per-person byte-identity.** Per-person jobs pass no `apiKeyId` → branch (0) skipped → identical DB queries and result (snapshot the existing resolver test — must stay green). The **only** wiring change is in `worker.ts`:
```ts
const resolved = await resolver.resolve({
  db: opts.db, orgId: payload.orgId, apiKeyId: payload.apiKeyId,   // undefined for per-person
});
```
`runEvaluation`, `upsertEvaluationReportByKey`, and `evaluation_reports_by_key` need **zero change** — the resolved `{rubricId, rubricVersion}` already flows into the by-key report.

**Staleness (documented, no regression):** an api-side edit can't invalidate the gateway's in-memory cache cross-process; edits apply within the existing 5-min TTL — identical to today's org `setActive`. **Locale:** the key branch is locale-agnostic (consistent with the per-key path passing no locale today).

---

## 4. tRPC API + RBAC

### 4.1 RBAC actions (packages/auth)

Cannot reuse `rubric.create/update/delete` — they gate **org_admin only** and would lock out the owning member. Add three actions in `actions.ts`, each shaped like `api_key.evaluate_as_project_set` (`{ apiKeyId, orgId, ownerUserId }`):

```
| { type: "rubric.read_key";   apiKeyId, orgId, ownerUserId }
| { type: "rubric.author_key"; apiKeyId, orgId, ownerUserId }   // create + edit (≤1/key ⇒ one upsert action)
| { type: "rubric.delete_key"; apiKeyId, orgId, ownerUserId }
```

`check.ts` — one grouped case cluster (super_admin already short-circuits):
```ts
case "rubric.read_key":
case "rubric.author_key":
case "rubric.delete_key":
  if (action.ownerUserId === perm.userId) return true;         // key owner (a member)
  return rolesAt(perm, "organization", action.orgId).has("org_admin");
```

### 4.2 New procedures on `rubricsRouter`

`getForKey`, `upsertForKey`, `deleteForKey`, each `{ apiKeyId }`. All call `ensureGatewayEnabled(ctx.env)` at the top (matching `setEvaluateAsProject`) so the authoring surface aligns with the per-key scoring gate.

**Key-first anti-enumeration (stronger NOT_FOUND):** each procedure resolves the key by id only (`SELECT userId, orgId, revokedAt FROM api_keys WHERE id`) and throws `NOT_FOUND` when the key is **missing OR revoked OR** the caller is **neither owner nor org_admin-of-key.orgId** — return `NOT_FOUND` even on found-but-unauthorized (not `FORBIDDEN`), mirroring `reports.assertOwnApiKey` / `resolveKeyInOrg`. This denies existence oracles to peer members and cross-org admins (the by-key report exposes `rubric_id`, so NOT_FOUND is the safer choice; minor inconsistency with `setEvaluateAsProject`'s FORBIDDEN is accepted). `author_key` additionally rejects a **revoked** key.

`upsertForKey` validates `definition` via `rubricSchema.safeParse` → `BAD_REQUEST` on failure; server-forces `apiKeyId = key.id`, `orgId = key.orgId`, `isDefault = false`, `createdBy = ctx.user.id` (on insert). Upsert: `INSERT … ON CONFLICT (api_key_id) WHERE api_key_id IS NOT NULL AND deleted_at IS NULL DO UPDATE` — a **soft-deleted** prior row frees the partial-index slot, so target the live row only; catch a concurrent-double-create unique violation and convert to update. `deleteForKey` soft-deletes (`deletedAt`). All three write an audit row (`rubric.key_set` / `rubric.key_cleared`, `targetType: api_key`, `targetId: key.id`).

### 4.3 Org-surface leak scoping (the crown-jewel fix)

Add `isNull(rubrics.apiKeyId)` to **every** existing org read/write of `rubrics` — all six sites:

| Procedure | Add | Why |
|---|---|---|
| `list` | `AND isNull(apiKeyId)` | hide key rubrics from org picker |
| `get` | `AND isNull(apiKeyId)` → NOT_FOUND | close owner-bypass side-channel |
| `update` | `AND isNull(apiKeyId)` | stop org_admin mutating a key rubric off the key-audit path |
| `delete` | `AND isNull(apiKeyId)` | same |
| `setActive` | reject `apiKeyId != null` | can't pin a key rubric as org-active |
| `dryRun` | `AND isNull(apiKeyId)` → NOT_FOUND | stop org_admin previewing any key's rubric |

**Second writer of `organizations.rubricId`:** `contentCapture.setSettings` writes `updates = {...input.patch}` including `rubricId` with no scope check. Add the same reject (when `patch.rubricId` resolves to a rubric with `apiKeyId != null` → `FORBIDDEN "rubric is key-scoped"`). Backstop: the resolver org-branch `isNull(apiKeyId)` (§3 step 1) is the final guard.

Key rubrics are addressable **only** via `getForKey` (owner + org_admin).

---

## 5. UI

Reuse `RubricEditor` unchanged in structure — replace `orgId` with a discriminated `target: { scope:"org"; orgId } | { scope:"key"; apiKeyId; orgId }`. Key scope loads via `rubrics.getForKey` and saves via `rubrics.upsertForKey` (single path, no create/update branch); the JSON form + `rubricSchema` client validation + file-upload + signal-type reference are 100% reused. Org mode stays byte-identical (still `create`/`update`).

**Entry points:**
- **Primary (owner + admin):** next to the `evaluateAsProject` toggle in `ApiKeyList.tsx` / `AdminApiKeyList.tsx`, an "Edit rubric" / "Remove custom rubric" affordance, **enabled only when `row.evaluateAsProject === true`**. Both lists carry owner/admin context + `useConfirm`.
- **Secondary:** a "Customize rubric" link in `ProjectScoreSection.tsx` for the selected key, plus a badge from resolver `source` ("custom key rubric" vs "uses org/platform rubric").

Gate entry points via `usePermissions().can({ type:"rubric.author_key", apiKeyId, orgId, ownerUserId })` and behind the same `ENABLE_PROJECT_EVALUATION` mechanism as the toggle.

**i18n (mandatory):** add new keys (e.g. `evaluator.rubrics.keyScope.{title,description,editButton,removeButton,confirmRemove,savedToast,removedToast,requiresOptInHint,customBadge,usesFallbackHint}` + `apiKeys.evaluateAsProject.editRubric`) to **all five** catalogs, reusing `evaluator.rubrics.editor.*` for shared form fields. A catalog-parity test asserts presence across en/zh-TW/zh-CN/ja/ko.

---

## 6. Edge cases

- **Key revoke (soft, `revokedAt`):** no cascade fires; the key rubric stays inert (the cron per-key pass enqueues nothing for revoked keys, so the resolver never runs for it). `author_key` blocked on a revoked key; `deleteForKey` allowed. Leave inert (reports already snapshot the scorer).
- **Key hard-delete / org-delete / user-delete:** `rubrics.api_key_id ON DELETE CASCADE` drops the key rubric. **Cascade convergence risk:** `evaluation_reports_by_key.rubric_id` is `ON DELETE RESTRICT` toward the same rubric. In prod keys are only soft-revoked; the sole hard-delete paths (org-delete cascade; GDPR) delete by-key reports **first** (gdprDelete deletes `evaluationReportsByKey` by `(user,org)` before any user removal; `evaluation_reports_by_key.user_id` RESTRICT structurally forces reports-gone-before-user), so by the time the rubric cascade fires there are no `rubric_id` references left to trip RESTRICT. **Must be covered by a real-DB integration test (PR7);** fallback is app-side soft-delete-before-hard-delete. `SET NULL` is **not** an option — it would turn a key rubric into an `apiKeyId=NULL`, org-visible rubric (a leak).
- **No-org-default / no-cross-key:** enforced by the CHECK (platform-default), the `setActive`/`contentCapture` rejects + resolver filter (org-active), and the partial unique index (one live rubric per key).
- **GDPR export (Art. 15/20):** `reports.exportOwn` currently never touches `rubrics`. Add `SELECT … FROM rubrics WHERE created_by = ctx.user.id AND api_key_id IS NOT NULL AND deleted_at IS NULL` to the export bundle.
- **GDPR erasure:** a key rubric is **project scoring config**, not personal content. On `bodies_and_reports` soft-erasure it is **kept** (consistent with org rubrics; the author link anonymizes via `createdBy ON DELETE SET NULL` only on eventual full user hard-delete). Document explicitly rather than relying on cascade/set-null on the soft path.

---

## 7. Build sequence (ordered PRs, each with a test note)

- **PR1 — DB + schema.** `rubrics.api_key_id` (cascade) + partial unique + CHECK + drizzle snapshot/journal + down migration. *Test (testcontainers):* migration up; second live rubric per key rejected by unique index; `is_default=true`/`org_id NULL` with `api_key_id` set rejected by CHECK; org-delete **and** key hard-delete both cascade-drop the key rubric; existing org/platform inserts + list/get unaffected; drizzle `when` applies on a clean DB.
- **PR2 — Resolver.** `apiKeyId` + `source`; key→org→platform; namespaced cache; `isNull(apiKeyId)` on org **and** platform branches. *Test (unit):* per-person result + cache key byte-identical (snapshot existing suite unchanged, incl. `fromOrgCustom`); key rubric returned when present; soft-deleted key rubric falls through; org-mismatched key rubric ignored; per-key vs per-person cache isolation.
- **PR3 — Worker wiring.** `worker.ts` passes `payload.apiKeyId`. *Test (real-DB):* per-key job **with** a key rubric writes `evaluation_reports_by_key.rubric_id` = key rubric id + version; **without** → org/platform fallback; per-person job unchanged.
- **PR4 — RBAC.** `rubric.read_key/author_key/delete_key` + grouped `check.ts` clause. *Test:* owner allowed, org_admin allowed, other member denied, cross-org admin denied, super_admin allowed.
- **PR5 — tRPC.** `getForKey/upsertForKey/deleteForKey` (`ensureGatewayEnabled`, key-first NOT_FOUND anti-enum, `rubricSchema` validate, server-forced scope, revoked-key author block, audit); add `isNull(apiKeyId)` to `list/get/update/delete/dryRun`; `setActive` + `contentCapture.setSettings` reject key rubrics. *Test:* owner upsert/read/delete happy path; peer member probe → NOT_FOUND; cross-org admin → NOT_FOUND; upsert can't set `is_default`/org scope; list/get/update/delete/dryRun exclude key rubrics; setActive + contentCapture reject a key rubric; concurrent double-create → unique violation converted to update; re-author after soft-delete targets the live slot.
- **PR6 — Web + i18n.** `RubricEditor` `target` union; entry points in ApiKeyList/AdminApiKeyList (enabled when `evaluateAsProject`) + ProjectScoreSection link + source badge; keys in all 5 catalogs; gate behind `ENABLE_PROJECT_EVALUATION`. *Test (RTL):* key mode calls `upsertForKey/getForKey`, org mode calls `create/update`; entry hidden when toggle/flag off; catalog-parity test across 5 locales.
- **PR7 — GDPR + cascade hardening.** Add user-authored key rubrics to `exportOwn`; document erasure semantics. *Test (real-DB):* export contains caller's key rubrics; api_key/org/user hard-delete ordering vs `evaluation_reports_by_key.rubric_id` RESTRICT does not abort (reports removed first); soft-erasure keeps the key rubric.

---

## 8. Dissent & risks

- **Maintenance tax (accepted).** `rubrics` now serves platform | org | key, so every current and future query must remember `isNull(api_key_id)` or re-open the org-picker/default leak. Mitigation: the six sites are patched + CHECK + partial-unique + resolver defense-in-depth. Optional follow-up: a shared `orgVisibleRubrics()` query helper as a single chokepoint.
- **Cross-process cache staleness (accepted, documented).** "I just edited my rubric and it didn't apply for ≤5 min" — same as org `setActive` today.
- **Cascade convergence (test-gated).** Prod uses soft-revoke; both hard-delete paths clear by-key reports first. PR7 proves it; fallback is app-side soft-delete-before-hard-delete.
- **Anti-enum choice.** NOT_FOUND-on-unauthorized is stronger than `setEvaluateAsProject`'s FORBIDDEN; chosen deliberately for the key-rubric surface.
- **Not over-built.** A forward-looking `source` discriminator is included, but no speculative `team_id`/`report_type` columns now (YAGNI) — the scope-on-rubric model admits them later as one nullable column + one ordered resolver step.

**Files touched:** `packages/db/src/schema/rubrics.ts` (+migration up/down); `apps/gateway/src/workers/evaluator/{rubricResolver.ts, worker.ts}`; `packages/auth/src/rbac/{actions.ts, check.ts}`; `apps/api/src/trpc/routers/{rubrics.ts, contentCapture.ts, reports.ts}`; `apps/web/src/components/evaluator/RubricEditor.tsx`, `apps/web/src/components/apiKeys/{ApiKeyList,AdminApiKeyList}.tsx`, `ProjectScoreSection.tsx`; `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`.
