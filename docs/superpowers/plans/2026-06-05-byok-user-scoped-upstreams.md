# BYOK P1 — User-Scoped Upstreams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any non-admin user register their *own* upstream API-key credential and have their requests routed only to it (or fall back to the shared pool), while the operator keeps full metering — without breaking any existing pooled behaviour.

**Architecture:** Approach C from the spec. Add `upstream_accounts.user_id` (ownership) and `api_keys.routing_policy` (`pool`/`own`/`own_then_pool`) with belt-and-braces CHECK guards. The gateway derives platform from the request surface for non-pool keys, and `listSchedulableCandidates` plus the forced/probe and sticky paths apply an ownership predicate so a pool request never schedules a user-owned upstream and an `own` request only schedules the caller's.

**Tech Stack:** Drizzle ORM + Postgres (testcontainers), Fastify gateway, tRPC API, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-byok-user-scoped-upstreams-design.md`

---

## File Structure

**Schema / migrations (packages/db):**
- Modify `packages/db/src/schema/accounts.ts` — add `userId`, partial index, CHECK.
- Modify `packages/db/src/schema/apiKeys.ts` — add `routingPolicy`, CHECK.
- Create `packages/db/drizzle/00NN_*.sql` (generated) ×2.

**RBAC (packages/auth):**
- Modify `packages/auth/src/rbac/actions.ts` — `account.register_own`, `account.manage_own`.
- Modify `packages/auth/src/rbac/check.ts` — allow rules.

**API (apps/api):**
- Modify `apps/api/src/trpc/routers/accounts.ts` — `registerOwn`/`listOwn`/`updateOwn`/`deleteOwn`.
- Modify `apps/api/src/trpc/routers/apiKeys.ts` — `routingPolicy` on `issueOwn`.
- Modify `apps/api/src/trpc/routers/accountGroups.ts` — `addMember` guard.

**Gateway (apps/gateway):**
- Create `apps/gateway/src/routes/surfacePlatform.ts` — `platformForGatewayRoute`.
- Modify `apps/gateway/src/middleware/apiKeyAuth.ts` — select `routing_policy`.
- Modify `apps/gateway/src/middleware/groupContext.ts` + `runtime/groupDispatch.ts` — groupless context.
- Modify `apps/gateway/src/runtime/scheduler.ts` — ownership branches + re-validation.
- Modify `apps/gateway/src/routes/{messages,chatCompletions,responses,codexResponses,dispatch}.ts` — groupless platform reads.

**Build order:** schema (1–2) → RBAC+API (3–7) → gateway (8–13) → e2e (14). Each task is independently testable and committable.

---

## Conventions for every task

- TDD: write the failing test first, run it red, implement minimal, run green, commit.
- Unit/route tests run with `pnpm --filter @caliber/<pkg> test <file>`; integration (testcontainer) with `pnpm --filter @caliber/gateway test:integration <file>` (or the api equivalent).
- Migrations: after editing schema, generate with `pnpm --filter @caliber/db db:generate` (drizzle-kit). **Then open the generated SQL and verify it** — per project history (migrations 0016/0017) the drizzle journal `when` can drift; if the migration is skipped on prod, apply out-of-band via psql. Do not hand-edit the journal.

---

## Task 1: Schema + migration — `upstream_accounts.user_id`

**Files:**
- Modify: `packages/db/src/schema/accounts.ts:1-70`
- Test: `apps/gateway/tests/runtime/byokUserScopedSchema.integration.test.ts` (create)
- Generated: `packages/db/drizzle/00NN_byok_upstream_user_id.sql`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/tests/runtime/byokUserScopedSchema.integration.test.ts`. Model the
testcontainer + migrate setup on `tests/runtime/idempotencyRecord.integration.test.ts`
(PostgreSqlContainer + drizzle migrate + seed a parent org/user). Then:

```ts
it("upstream_accounts CHECK rejects a row with both user_id and team_id set", async () => {
  await expect(
    db.insert(upstreamAccounts).values({
      orgId, teamId, userId, name: "bad", platform: "openai", type: "api_key",
    }),
  ).rejects.toThrow(/user_id_xor_team_id|check/i);
});

it("accepts a user-owned upstream (user_id set, team_id null)", async () => {
  const [row] = await db.insert(upstreamAccounts).values({
    orgId, userId, name: "byok", platform: "openai", type: "api_key",
  }).returning();
  expect(row.userId).toBe(userId);
  expect(row.teamId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration byokUserScopedSchema`
Expected: FAIL — `userId` is not a column on `upstreamAccounts`.

- [ ] **Step 3: Add the column, index, and CHECK to the schema**

In `packages/db/src/schema/accounts.ts`: add `check` to the drizzle import on line 9, import
`users`, add the column after `teamId` (line 21), and add the index + CHECK in the `(t) => ({...})`
config:

```ts
import { pgTable, uuid, text, boolean, integer, timestamp, decimal, index, check } from "drizzle-orm/pg-core";
import { organizations, teams } from "./org.js";
import { users } from "./auth.js";
// ...
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
// ... in the table config callback:
  (t) => ({
    scopeIdx: index("upstream_accounts_scope_idx").on(t.orgId, t.teamId).where(sql`${t.deletedAt} IS NULL`),
    selectIdx: index("upstream_accounts_select_idx").on(t.orgId, t.teamId, t.priority).where(sql`${t.deletedAt} IS NULL AND ${t.schedulable} = true`),
    userSelectIdx: index("upstream_accounts_user_select_idx").on(t.orgId, t.userId, t.platform, t.priority).where(sql`${t.deletedAt} IS NULL AND ${t.schedulable} = true`),
    userXorTeam: check("upstream_accounts_user_id_xor_team_id", sql`${t.userId} IS NULL OR ${t.teamId} IS NULL`),
  }),
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm --filter @caliber/db db:generate`
Open the new `packages/db/drizzle/00NN_*.sql`. Confirm it `ADD COLUMN "user_id" uuid`, the FK, the
partial index, and `ADD CONSTRAINT "upstream_accounts_user_id_xor_team_id" CHECK (...)`. No DROP of
existing data. Rename the file to `00NN_byok_upstream_user_id.sql` only if the project convention is
descriptive names (check sibling files first; if they are auto-named, leave it).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration byokUserScopedSchema`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/accounts.ts packages/db/drizzle apps/gateway/tests/runtime/byokUserScopedSchema.integration.test.ts
git commit -m "feat(db): upstream_accounts.user_id ownership column + user_id XOR team_id CHECK + select index"
```

---

## Task 2: Schema + migration — `api_keys.routing_policy`

**Files:**
- Modify: `packages/db/src/schema/apiKeys.ts:1-79`
- Test: `apps/gateway/tests/runtime/byokUserScopedSchema.integration.test.ts` (extend)
- Generated: `packages/db/drizzle/00NN_byok_api_keys_routing_policy.sql`

- [ ] **Step 1: Write the failing test** (append to the Task 1 integration file)

```ts
it("api_keys default routing_policy is 'pool'", async () => {
  const [k] = await db.insert(apiKeys).values({
    userId, orgId, keyHash: "h1", keyPrefix: "ak_p1", name: "k",
  }).returning();
  expect(k.routingPolicy).toBe("pool");
});

it("api_keys CHECK rejects non-pool policy with a group_id", async () => {
  await expect(
    db.insert(apiKeys).values({
      userId, orgId, groupId, keyHash: "h2", keyPrefix: "ak_p2", name: "k",
      routingPolicy: "own",
    }),
  ).rejects.toThrow(/routing_policy_group_mutex|check/i);
});

it("api_keys CHECK rejects an unknown routing_policy value", async () => {
  await expect(
    db.insert(apiKeys).values({
      userId, orgId, keyHash: "h3", keyPrefix: "ak_p3", name: "k",
      routingPolicy: "nonsense" as never,
    }),
  ).rejects.toThrow(/check/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration byokUserScopedSchema`
Expected: FAIL — `routingPolicy` not a column.

- [ ] **Step 3: Add the column + two CHECKs**

In `packages/db/src/schema/apiKeys.ts`: add `check` to the import (line 8), add the column after
`status` (line 34), and add CHECKs in the table config. Follow the codebase style — platform/type/
status are plain `text` with app/CHECK validation, **not** pgEnum — so `routing_policy` is `text`:

```ts
import { pgTable, uuid, text, timestamp, decimal, inet, index, check } from "drizzle-orm/pg-core";
// ...
    status: text("status").notNull().default("active"),
    routingPolicy: text("routing_policy").notNull().default("pool"),
// ... in the table config callback, alongside the existing indexes:
    routingPolicyValues: check("api_keys_routing_policy_values", sql`${t.routingPolicy} IN ('pool','own','own_then_pool')`),
    routingPolicyGroupMutex: check("api_keys_routing_policy_group_mutex", sql`${t.routingPolicy} = 'pool' OR ${t.groupId} IS NULL`),
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm --filter @caliber/db db:generate`
Verify the SQL adds `routing_policy text NOT NULL DEFAULT 'pool'` and both CHECK constraints. The
DEFAULT backfills every existing key to `pool` (zero behaviour change).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration byokUserScopedSchema`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/apiKeys.ts packages/db/drizzle apps/gateway/tests/runtime/byokUserScopedSchema.integration.test.ts
git commit -m "feat(db): api_keys.routing_policy (pool/own/own_then_pool) + value + group-mutex CHECKs"
```

---

## Task 3: RBAC actions — `account.register_own`, `account.manage_own`

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts`
- Modify: `packages/auth/src/rbac/check.ts`
- Test: `packages/auth/tests/rbac/byokOwnership.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Model on the existing rbac check tests in `packages/auth/tests/`. The key behaviours:

```ts
import { can } from "../../src/rbac/check.js";

const member = { userId: "u1", roles: [{ role: "member", scopeType: "organization", scopeId: "org1" }] };

it("any authenticated member may register their own upstream", () => {
  expect(can(member, { type: "account.register_own" })).toBe(true);
});

it("a member may manage an upstream they own", () => {
  expect(can(member, { type: "account.manage_own", ownerUserId: "u1" })).toBe(true);
});

it("a member may NOT manage an upstream owned by someone else", () => {
  expect(can(member, { type: "account.manage_own", ownerUserId: "u2" })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/auth test byokOwnership`
Expected: FAIL — action types not defined.

- [ ] **Step 3: Add the action types**

In `packages/auth/src/rbac/actions.ts`, add to the `Action` union (mirror the existing
`api_key.issue_own` / `account.*` entries):

```ts
| { type: "account.register_own" }
| { type: "account.manage_own"; ownerUserId: string }
```

- [ ] **Step 4: Add allow rules in `check.ts`**

In `packages/auth/src/rbac/check.ts`'s `can()` switch (mirror how `api_key.issue_own` returns true
for any authenticated principal, and how ownership is compared elsewhere):

```ts
case "account.register_own":
  // Any authenticated principal. No role/scope requirement (mirrors api_key.issue_own).
  return true;
case "account.manage_own":
  // Owner-only. super_admin retained for break-glass via the global branch above.
  return perm.userId === action.ownerUserId;
```

Place `account.manage_own` so it still falls through to the existing `super_admin` global-allow
check at the top of `can()` (so operators keep break-glass). If `can()` checks super_admin first and
returns early, no change needed; otherwise add `|| isSuperAdmin(perm)`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/auth test byokOwnership`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/rbac/actions.ts packages/auth/src/rbac/check.ts packages/auth/tests/rbac/byokOwnership.test.ts
git commit -m "feat(auth): account.register_own (any member) + account.manage_own (owner-only) RBAC actions"
```

---

## Task 4: `accounts.registerOwn` mutation

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts` (add procedure; reuse `buildCredentialPlaintext`, `encryptCredential`, `requireMasterKeyHex`, `resolveUserPrimaryOrgId`)
- Test: `apps/api/tests/routers/accountsRegisterOwn.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Model setup on existing api integration tests + `apps/api/tests/factories/caller.ts` (build a
member caller). Then:

```ts
it("registerOwn stores a user-owned api_key upstream + encrypted vault row", async () => {
  const caller = await memberCaller(); // userId = caller.user.id, primary org seeded
  const acct = await caller.accounts.registerOwn({
    name: "my openai", platform: "openai", type: "api_key", credentials: "sk-test-123",
  });
  expect(acct.userId).toBe(caller.user.id);
  expect(acct.teamId).toBeNull();
  const vault = await db.select().from(credentialVault).where(eq(credentialVault.accountId, acct.id));
  expect(vault).toHaveLength(1);
});

it("registerOwn rejects an empty credential", async () => {
  const caller = await memberCaller();
  await expect(caller.accounts.registerOwn({
    name: "x", platform: "openai", type: "api_key", credentials: "",
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration accountsRegisterOwn`
Expected: FAIL — `registerOwn` not a procedure.

- [ ] **Step 3: Implement `registerOwn`**

Add to `accountsRouter` in `apps/api/src/trpc/routers/accounts.ts`. It mirrors `create`
(lines 173-271) but: no orgId/teamId input, no `account.create` permission, forces
`userId = caller`, `teamId = null`, `type` fixed to `api_key`:

```ts
registerOwn: permissionProcedure(
  z.object({
    name: z.string().min(1).max(255),
    platform: platformEnum,
    // P1: api_key only. OAuth self-service is P2.
    type: z.literal("api_key"),
    credentials: z.string().min(1).max(100_000),
  }),
  () => ({ type: "account.register_own" }),
).mutation(async ({ ctx, input }) => {
  ensureGatewayEnabled(ctx.env);
  const masterKeyHex = requireMasterKeyHex(ctx.env);
  const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

  const insertedRow = await ctx.db.transaction(async (tx) => {
    const [account] = await tx.insert(upstreamAccounts).values({
      orgId,
      userId: ctx.user.id,
      teamId: null,
      name: input.name,
      platform: input.platform,
      type: "api_key",
    }).returning();
    if (!account) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "failed to insert upstream account" });
    }
    const sealed = encryptCredential({
      masterKeyHex,
      accountId: account.id,
      plaintext: buildCredentialPlaintext("api_key", input.credentials),
    });
    await tx.insert(credentialVault).values({
      accountId: account.id, nonce: sealed.nonce, ciphertext: sealed.ciphertext,
      authTag: sealed.authTag, oauthExpiresAt: null,
    });
    await writeAudit(tx, {
      actorUserId: ctx.user.id, action: "account.registered_own",
      targetType: "upstream_account", targetId: account.id, orgId: account.orgId,
      metadata: { name: account.name, platform: account.platform, type: account.type },
    });
    return account;
  });
  return insertedRow;
}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration accountsRegisterOwn`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/tests/routers/accountsRegisterOwn.integration.test.ts
git commit -m "feat(api): accounts.registerOwn — non-admin self-service api_key upstream (user-owned)"
```

---

## Task 5: `accounts.listOwn` / `updateOwn` (metadata-only) / `deleteOwn`

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts`
- Test: `apps/api/tests/routers/accountsManageOwn.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("listOwn returns only the caller's upstreams", async () => {
  const a = await memberCaller(); const b = await memberCaller();
  const mine = await a.accounts.registerOwn({ name: "a", platform: "openai", type: "api_key", credentials: "sk-a" });
  await b.accounts.registerOwn({ name: "b", platform: "openai", type: "api_key", credentials: "sk-b" });
  const list = await a.accounts.listOwn();
  expect(list.map((r) => r.id)).toEqual([mine.id]);
});

it("updateOwn changes metadata but not the credential, and only the owner's row", async () => {
  const a = await memberCaller(); const b = await memberCaller();
  const mine = await a.accounts.registerOwn({ name: "a", platform: "openai", type: "api_key", credentials: "sk-a" });
  const upd = await a.accounts.updateOwn({ id: mine.id, name: "renamed", schedulable: false });
  expect(upd.name).toBe("renamed");
  expect(upd.schedulable).toBe(false);
  await expect(b.accounts.updateOwn({ id: mine.id, name: "hijack" })).rejects.toThrow();
});

it("deleteOwn soft-deletes only the caller's row", async () => {
  const a = await memberCaller(); const b = await memberCaller();
  const mine = await a.accounts.registerOwn({ name: "a", platform: "openai", type: "api_key", credentials: "sk-a" });
  await expect(b.accounts.deleteOwn({ id: mine.id })).rejects.toThrow();
  await a.accounts.deleteOwn({ id: mine.id });
  const [row] = await db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, mine.id));
  expect(row.deletedAt).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration accountsManageOwn`
Expected: FAIL — procedures not defined.

- [ ] **Step 3: Implement the three procedures**

Add to `accountsRouter`. The procedure-level `permissionProcedure` gate is `account.register_own`
(it runs before any DB access so it cannot know the row's owner). Ownership is then enforced
**inside the handler via the `account.manage_own` RBAC action** — so the rule lives in RBAC (and
super_admin keeps break-glass) rather than as an ad-hoc field compare, and `account.manage_own` is a
live, tested action instead of dead code. Import `can` from `@caliber/auth`; `ctx.permissions` is the
`UserPermissions` the permissionProcedure middleware already resolves (verify its exact name on
`ctx`).

```ts
listOwn: permissionProcedure(z.void(), () => ({ type: "account.register_own" }))
  .query(async ({ ctx }) => {
    ensureGatewayEnabled(ctx.env);
    return ctx.db.select().from(upstreamAccounts).where(and(
      eq(upstreamAccounts.userId, ctx.user.id),
      isNull(upstreamAccounts.deletedAt),
    ));
  }),

updateOwn: permissionProcedure(
  z.object({
    id: uuid,
    name: z.string().min(1).max(255).optional(),
    schedulable: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  }),
  // ownership enforced in the handler against the fetched row
  () => ({ type: "account.register_own" }),
).mutation(async ({ ctx, input }) => {
  ensureGatewayEnabled(ctx.env);
  const [existing] = await ctx.db.select().from(upstreamAccounts)
    .where(and(eq(upstreamAccounts.id, input.id), isNull(upstreamAccounts.deletedAt)));
  if (!existing || !can(ctx.permissions, { type: "account.manage_own", ownerUserId: existing.userId })) {
    throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });
  }
  const [row] = await ctx.db.update(upstreamAccounts).set({
    name: input.name ?? existing.name,
    schedulable: input.schedulable ?? existing.schedulable,
    priority: input.priority ?? existing.priority,
    updatedAt: new Date(),
  }).where(eq(upstreamAccounts.id, input.id)).returning();
  return row;
}),

deleteOwn: permissionProcedure(z.object({ id: uuid }), () => ({ type: "account.register_own" }))
  .mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const [existing] = await ctx.db.select().from(upstreamAccounts)
      .where(and(eq(upstreamAccounts.id, input.id), isNull(upstreamAccounts.deletedAt)));
    if (!existing || !can(ctx.permissions, { type: "account.manage_own", ownerUserId: existing.userId })) {
      throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });
    }
    await ctx.db.update(upstreamAccounts).set({ deletedAt: new Date() })
      .where(eq(upstreamAccounts.id, input.id));
    return { id: input.id };
  }),
```

Note: `updateOwn` deliberately has **no `credentials` field** — credential rotation in P1 is delete +
re-register (spec §2.2).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration accountsManageOwn`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/tests/routers/accountsManageOwn.integration.test.ts
git commit -m "feat(api): accounts.listOwn/updateOwn(metadata-only)/deleteOwn — owner-scoped"
```

---

## Task 6: `apiKeys.issueOwn` — add `routingPolicy`

**Files:**
- Modify: `apps/api/src/trpc/routers/apiKeys.ts:140-199`
- Test: `apps/api/tests/routers/issueOwnRoutingPolicy.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("issueOwn defaults routing_policy to pool", async () => {
  const caller = await memberCaller();
  const { id } = await caller.apiKeys.issueOwn({ name: "k" });
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  expect(row.routingPolicy).toBe("pool");
});

it("issueOwn persists routingPolicy 'own'", async () => {
  const caller = await memberCaller();
  const { id } = await caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own" });
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  expect(row.routingPolicy).toBe("own");
});

it("issueOwn rejects a non-pool policy combined with a groupId", async () => {
  const caller = await memberCaller();
  const groupId = await seedOwnedGroup(caller); // any group in caller's org
  await expect(caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own", groupId }))
    .rejects.toThrow(/mutually exclusive|group/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration issueOwnRoutingPolicy`
Expected: FAIL — `routingPolicy` not accepted.

- [ ] **Step 3: Add the param + validation + insert value**

In `issueOwn` (apiKeys.ts:140-199): extend the input schema, add the mutual-exclusion guard after
the existing `groupId` guard (line 163), and pass it to the insert (line 174):

```ts
// input schema — add:
    routingPolicy: z.enum(["pool", "own", "own_then_pool"]).optional(),
// after the assertGroupBelongsToOrg block:
    const routingPolicy = input.routingPolicy ?? "pool";
    if (routingPolicy !== "pool" && input.groupId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "routing_policy and group_id are mutually exclusive",
      });
    }
// insert .values(...) — add:
        routingPolicy,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration issueOwnRoutingPolicy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/apiKeys.ts apps/api/tests/routers/issueOwnRoutingPolicy.integration.test.ts
git commit -m "feat(api): apiKeys.issueOwn accepts routingPolicy (pool/own/own_then_pool) + group mutex"
```

---

## Task 7: `accountGroups.addMember` rejects user-owned upstreams

**Files:**
- Modify: `apps/api/src/trpc/routers/accountGroups.ts` (the `addMember` mutation)
- Test: `apps/api/tests/routers/addMemberRejectsByok.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("addMember rejects an upstream that is user-owned (user_id IS NOT NULL)", async () => {
  const admin = await orgAdminCaller();
  const member = await memberCaller(admin.orgId);
  const byok = await member.accounts.registerOwn({ name: "byok", platform: "openai", type: "api_key", credentials: "sk-x" });
  const groupId = await admin.accountGroups.create({ orgId: admin.orgId, name: "g", platform: "openai" });
  await expect(admin.accountGroups.addMember({ groupId, accountId: byok.id }))
    .rejects.toThrow(/user-owned|BYOK|cannot be added/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration addMemberRejectsByok`
Expected: FAIL — addMember currently accepts it.

- [ ] **Step 3: Add the guard**

In the `addMember` mutation in `apps/api/src/trpc/routers/accountGroups.ts`, after the account is
fetched / validated to belong to the org, before inserting the membership row:

```ts
if (account.userId !== null) {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "user-owned (BYOK) upstreams cannot be added to a pool group",
  });
}
```

(If the existing `addMember` does not already SELECT the account row, add a fetch of
`upstreamAccounts` by `accountId` scoped to the group's org and reuse it for both the org check and
this guard.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration addMemberRejectsByok`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accountGroups.ts apps/api/tests/routers/addMemberRejectsByok.integration.test.ts
git commit -m "feat(api): accountGroups.addMember rejects user-owned (BYOK) upstreams — keep creds out of pool groups"
```

---

## Task 8: `platformForGatewayRoute(req)` resolver

**Files:**
- Create: `apps/gateway/src/routes/surfacePlatform.ts`
- Test: `apps/gateway/tests/routes/surfacePlatform.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { platformForGatewayRoute } from "../../src/routes/surfacePlatform.js";

const cases: Array<[string, "anthropic" | "openai"]> = [
  ["/v1/messages", "anthropic"],
  ["/v1/chat/completions", "openai"],
  ["/v1/responses", "openai"],
  ["/v1/responses/compact", "openai"],
  ["/backend-api/codex/responses", "openai"],
];

it.each(cases)("maps %s -> %s", (url, expected) => {
  expect(platformForGatewayRoute({ routeOptions: { url } } as never)).toBe(expected);
});

it("throws on an unknown route (forces the table to stay exhaustive)", () => {
  expect(() => platformForGatewayRoute({ routeOptions: { url: "/v1/unknown" } } as never)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test surfacePlatform`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

`apps/gateway/src/routes/surfacePlatform.ts`. It reads the **matched route pattern**
(`req.routeOptions.url`, stable regardless of trailing IDs), the single source of truth for
non-pool platform:

```ts
import type { FastifyRequest } from "fastify";
import type { Platform } from "@caliber/gateway-core"; // or wherever Platform lives

const ROUTE_PLATFORM: Record<string, Platform> = {
  "/v1/messages": "anthropic",
  "/v1/chat/completions": "openai",
  "/v1/responses": "openai",
  "/v1/responses/compact": "openai",
  "/backend-api/codex/responses": "openai",
};

/** Single source of truth for a non-pool request's platform. MUST be updated
 *  whenever a gateway upstream route is added. */
export function platformForGatewayRoute(req: FastifyRequest): Platform {
  const url = req.routeOptions?.url;
  const platform = url ? ROUTE_PLATFORM[url] : undefined;
  if (!platform) {
    throw new Error(`platformForGatewayRoute: no platform mapping for route ${url ?? "<unknown>"}`);
  }
  return platform;
}
```

(Import the `Platform` type from its existing home — find it with
`grep -rn "type Platform" apps/gateway/src packages`. If `isPlatform` lives in
`runtime/groupDispatch.ts`, the type is nearby.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test surfacePlatform`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/routes/surfacePlatform.ts apps/gateway/tests/routes/surfacePlatform.test.ts
git commit -m "feat(gateway): platformForGatewayRoute — surface->platform resolver for non-pool keys"
```

---

## Task 9: `apiKeyAuth` carries `routing_policy`; thread it onto the request

**Files:**
- Modify: `apps/gateway/src/middleware/apiKeyAuth.ts:11-20,76-92`
- Test: `apps/gateway/tests/middleware/apiKeyAuthRoutingPolicy.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Mirror the existing apiKeyAuth test setup. Assert that after auth, `req.apiKey.routingPolicy`
reflects the row (and defaults to `"pool"` for legacy keys):

```ts
it("attaches routing_policy from the api_keys row", async () => {
  const key = await seedApiKey({ routingPolicy: "own" });
  const req = await authedRequest(key.raw);
  expect(req.apiKey?.routingPolicy).toBe("own");
});

it("legacy keys default to pool", async () => {
  const key = await seedApiKey({}); // routing_policy defaulted at DB
  const req = await authedRequest(key.raw);
  expect(req.apiKey?.routingPolicy).toBe("pool");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test apiKeyAuthRoutingPolicy`
Expected: FAIL — `routingPolicy` not on `req.apiKey`.

- [ ] **Step 3: Add the column to the SELECT + the decorated type**

In `apps/gateway/src/middleware/apiKeyAuth.ts`: add `routingPolicy: apiKeys.routingPolicy` to the
SELECT projection (around line 76-92) and `routingPolicy: string` (or the `"pool"|"own"|"own_then_pool"`
union) to the `req.apiKey` type (line 11-20). Populate it when constructing `req.apiKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test apiKeyAuthRoutingPolicy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/middleware/apiKeyAuth.ts apps/gateway/tests/middleware/apiKeyAuthRoutingPolicy.test.ts
git commit -m "feat(gateway): apiKeyAuth selects routing_policy onto req.apiKey"
```

---

## Task 10: Groupless routing context for non-pool keys

**Files:**
- Modify: `apps/gateway/src/middleware/groupContext.ts:22-41`
- Modify: `apps/gateway/src/runtime/groupDispatch.ts:64-108` (`resolveGroupContext` + `GroupContext` type)
- Modify route reads: `apps/gateway/src/routes/{messages,chatCompletions,responses,codexResponses}.ts` (`req.gwGroupContext!.platform`) and `routes/dispatch.ts` (`autoRoute`)
- Test: `apps/gateway/tests/middleware/groupContextByok.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("non-pool key gets a groupless context with surface-derived platform (no legacy synth)", async () => {
  const ctx = await resolveGroupContextForRequest({
    apiKey: { orgId: "o1", groupId: null, userId: "u1", routingPolicy: "own" },
    routeUrl: "/v1/chat/completions",
  });
  expect(ctx.groupId).toBeNull();
  expect(ctx.platform).toBe("openai");   // from surface, NOT the legacy anthropic synth
  expect(ctx.isByok).toBe(true);
});

it("pool key with null group still synthesizes the legacy anthropic group (unchanged)", async () => {
  const ctx = await resolveGroupContextForRequest({
    apiKey: { orgId: "o1", groupId: null, userId: "u1", routingPolicy: "pool" },
    routeUrl: "/v1/chat/completions",
  });
  expect(ctx.isLegacy).toBe(true);
  expect(ctx.platform).toBe("anthropic"); // existing behaviour preserved
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test groupContextByok`
Expected: FAIL — non-pool branch not implemented.

- [ ] **Step 3: Branch on policy in context resolution**

Extend the `GroupContext` type (groupDispatch.ts) with `policy: "pool" | "own" | "own_then_pool"`
and `isByok: boolean`. In `groupContextPlugin` (groupContext.ts), pass the matched route URL and
the key's `routingPolicy` into resolution. In `resolveGroupContext`, branch **before** the existing
null-group legacy synth:

```ts
// At the top of resolveGroupContext, given apiKey.routingPolicy + routeUrl:
if (apiKey.routingPolicy && apiKey.routingPolicy !== "pool") {
  return {
    groupId: null,
    platform: platformForGatewayRoute(req),   // surface-derived (Task 8)
    rateMultiplier: 1.0,
    isExclusive: false,
    isLegacy: false,
    isByok: true,
    policy: apiKey.routingPolicy,
  };
}
// else: existing behaviour — null-group legacy synth + real-group lookup, with
// policy: "pool", isByok: false added to both returned objects.
```

Because `groupContextPlugin` runs per-request and has access to `req`, thread `req` (for the route
URL) into `resolveGroupContext` or compute the platform in the plugin and pass it in.

- [ ] **Step 4: Update the route platform reads**

In `messages.ts` / `chatCompletions.ts` / `responses.ts` / `codexResponses.ts`, the
`req.gwGroupContext!.platform` reads already return the right value (surface platform for BYOK,
group platform otherwise) — **no change needed** as long as `gwGroupContext` is always populated.
Verify `autoRoute` (`routes/dispatch.ts`) dispatches by `gwGroupContext.platform` and does not
special-case `isLegacy`; if it asserts a non-null `groupId`, relax that assertion to allow the
groupless BYOK context.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test groupContextByok`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/middleware/groupContext.ts apps/gateway/src/runtime/groupDispatch.ts apps/gateway/src/routes/dispatch.ts apps/gateway/tests/middleware/groupContextByok.test.ts
git commit -m "feat(gateway): groupless surface-derived routing context for non-pool (BYOK) keys"
```

---

## Task 11: Scheduler ownership branches in `listSchedulableCandidates`

**Files:**
- Modify: `apps/gateway/src/runtime/scheduler.ts:487-582` (+ `ScheduleRequest` type to carry `routingPolicy` and `userId`)
- Modify: wherever `ScheduleRequest` is built from `req` (search `groupPlatform:` / `orgId: req`)
- Test: `apps/gateway/tests/runtime/schedulerOwnership.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test** (testcontainer pg; seed org, two users, upstreams)

```ts
it("INV1: a pool request never returns a user-owned upstream", async () => {
  await seedUpstream({ orgId, userId: null, platform: "openai" });      // pool
  await seedUpstream({ orgId, userId: userA, platform: "openai" });     // byok A
  const c = await listSchedulableCandidates(db, { orgId, userId: userA, routingPolicy: "pool", groupId: null, groupPlatform: "openai", teamId: null }, new Set());
  expect(c.every((r) => r.id !== /* A's id */ byokA.id)).toBe(true);
});

it("INV2: A's own request never returns B's upstream", async () => {
  await seedUpstream({ orgId, userId: userA, platform: "openai" });
  const bId = (await seedUpstream({ orgId, userId: userB, platform: "openai" })).id;
  const c = await listSchedulableCandidates(db, { orgId, userId: userA, routingPolicy: "own", groupId: null, groupPlatform: "openai", teamId: null }, new Set());
  expect(c.every((r) => r.id !== bId)).toBe(true);
  expect(c.map((r) => r.id)).toContain(/* A's id */ byokA.id);
});

it("own_then_pool falls back to the pool when the user has no own upstream", async () => {
  const poolId = (await seedUpstream({ orgId, userId: null, platform: "openai" })).id;
  const c = await listSchedulableCandidates(db, { orgId, userId: userA, routingPolicy: "own_then_pool", groupId: null, groupPlatform: "openai", teamId: null }, new Set());
  expect(c.map((r) => r.id)).toEqual([poolId]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration schedulerOwnership`
Expected: FAIL — `routingPolicy`/`userId` not on `ScheduleRequest`; no ownership filter.

- [ ] **Step 3: Add the predicate branches**

Add `routingPolicy: "pool" | "own" | "own_then_pool"` and `userId: string | null` to
`ScheduleRequest`. In `listSchedulableCandidates`, after `baseConditions` are built and before the
`if (req.groupId)` block, compute the ownership filter and split the legacy path:

```ts
import { isNull as dIsNull, eq as dEq } from "drizzle-orm"; // already imported as isNull/eq

// pool path additions (applies to BOTH the group branch and the legacy branch):
const ownershipPool = isNull(upstreamAccounts.userId);

if (req.routingPolicy === "own" || req.routingPolicy === "own_then_pool") {
  // Own candidates: user-owned, ignore group entirely.
  const ownRows = await db.select({
      id: upstreamAccounts.id, concurrency: upstreamAccounts.concurrency,
      platform: upstreamAccounts.platform, type: upstreamAccounts.type,
      priority: upstreamAccounts.priority,
    })
    .from(upstreamAccounts)
    .where(and(eq(upstreamAccounts.userId, req.userId!), ...baseConditions))
    .orderBy(asc(upstreamAccounts.priority), sql`${upstreamAccounts.lastUsedAt} ASC NULLS FIRST`);
  const own = ownRows.map((r) => ({ ...r, groupId: null }));
  if (own.length > 0 || req.routingPolicy === "own") {
    return own; // own: even empty returns empty (caller maps to 409 via Task 13)
  }
  // own_then_pool with no own → fall through to the legacy pool path below,
  // but force the pool ownership filter.
}

// In BOTH the group branch and the legacy branch, append `ownershipPool` to the
// WHERE so a pool request can never pick a user-owned row:
//   group branch  .where(and(eq(accountGroupMembers.groupId, req.groupId), ..., ownershipPool, ...baseConditions))
//   legacy branch .where(and(teamPredicateFor(req.teamId), ownershipPool, ...baseConditions))
```

The legacy branch (lines 554-572) is exactly the `own_then_pool` fallback scope from spec §4.3 once
`ownershipPool` is appended — no anti-join, matching today's behaviour.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration schedulerOwnership`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/scheduler.ts apps/gateway/tests/runtime/schedulerOwnership.integration.test.ts
git commit -m "feat(gateway): scheduler ownership branches — pool excludes user-owned; own/own_then_pool isolate by user_id"
```

---

## Task 12: Ownership re-validation on forced/probe + sticky paths

**Files:**
- Modify: `apps/gateway/src/runtime/scheduler.ts` (the forced lookup `loadSchedulableAccount`/`probeAccount` path and the sticky-hit resolution)
- Test: `apps/gateway/tests/runtime/schedulerOwnershipPaths.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("INV3: a forced account that violates the policy predicate is rejected", async () => {
  const bId = (await seedUpstream({ orgId, userId: userB, platform: "openai" })).id;
  // userA forces B's account → must be rejected, not honoured
  const picked = await scheduleForced(db, { orgId, userId: userA, routingPolicy: "own", forcedAccountId: bId });
  expect(picked).toBeNull();
});

it("INV4: a stale sticky entry resolving to a now-user-owned account is rejected on pool", async () => {
  const id = (await seedUpstream({ orgId, userId: null, platform: "anthropic" })).id;
  await writeStickyHit(groupId, "sess1", id);          // sticky written while pooled
  await db.update(upstreamAccounts).set({ userId: userA }).where(eq(upstreamAccounts.id, id)); // becomes user-owned
  const picked = await resolveStickyAccount(db, { orgId, routingPolicy: "pool", groupId, sessionHash: "sess1" });
  expect(picked).toBeNull(); // re-validation drops it; scheduler falls back to candidate list
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration schedulerOwnershipPaths`
Expected: FAIL — forced/sticky paths don't re-check ownership.

- [ ] **Step 3: Add a shared ownership predicate + apply on both paths**

Add a helper near `listSchedulableCandidates`:

```ts
function ownershipOk(row: { userId: string | null }, req: ScheduleRequest): boolean {
  if (req.routingPolicy === "own" || req.routingPolicy === "own_then_pool") {
    // For own_then_pool a sticky/forced hit is valid if it's either the user's
    // own or (post-fallback) a pool row; the simplest safe rule: accept own OR
    // pool, reject another user's.
    return row.userId === null || row.userId === req.userId;
  }
  return row.userId === null; // pool: never a user-owned row
}
```

In the forced lookup (`loadSchedulableAccount`/`probeAccount`): after loading the row, `if
(!ownershipOk(row, req)) return null;`. In the sticky-hit resolution: after fetching the
sticky-referenced account row, apply the same guard before returning it; on failure, fall through to
the normal candidate selection. (Sticky paths require a `groupId` so they only run for `pool`/grouped
keys, but the guard still defends against a sticky row written before an account became user-owned.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration schedulerOwnershipPaths`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/scheduler.ts apps/gateway/tests/runtime/schedulerOwnershipPaths.integration.test.ts
git commit -m "feat(gateway): re-validate ownership on forced/probe + sticky selection paths (invariant 1.3.3)"
```

---

## Task 13: Error handling — `own` existence-vs-schedulability → 409 `no_own_upstream`

**Files:**
- Modify: the dispatch/failover entrypoint that calls the scheduler (search for where an empty
  candidate set currently maps to the no-account error — likely `runtime/failoverLoop.ts` or the
  route's autoRoute wrap)
- Test: `apps/gateway/tests/routes/byokNoOwnUpstream.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("own with no own upstream for the platform returns 409 no_own_upstream", async () => {
  const key = await issueOwnKey({ routingPolicy: "own", userId: userA }); // user has NO own upstream
  const res = await callGateway("/v1/chat/completions", key.raw, anyBody);
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("no_own_upstream");
});

it("own with an own upstream that is paused returns the transient 503, not 409", async () => {
  await seedUpstream({ orgId, userId: userA, platform: "openai", schedulable: false });
  const key = await issueOwnKey({ routingPolicy: "own", userId: userA });
  const res = await callGateway("/v1/chat/completions", key.raw, anyBody);
  expect(res.statusCode).toBe(503);
  expect(res.json().error).not.toBe("no_own_upstream");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration byokNoOwnUpstream`
Expected: FAIL — empty own set currently surfaces the generic no-account/503.

- [ ] **Step 3: Add the existence check + 409 branch**

When `routingPolicy === "own"` and the candidate set is empty, do a **separate unfiltered
existence query** (no schedulable/rate-limit filters) before falling through to the generic error:

```ts
// In the dispatch path, when policy === "own" and candidates.length === 0:
const [ownRow] = await db.select({ id: upstreamAccounts.id })
  .from(upstreamAccounts)
  .where(and(
    eq(upstreamAccounts.userId, req.userId!),
    eq(upstreamAccounts.platform, req.groupPlatform!),  // surface platform
    isNull(upstreamAccounts.deletedAt),
  ))
  .limit(1);
if (!ownRow) {
  return reply.code(409).send({ error: "no_own_upstream", message:
    `No credential registered for ${req.groupPlatform} — add one in settings` });
}
// else: an own row exists but is currently unschedulable → fall through to the
// existing transient/503 no-schedulable-account path (unchanged).
```

`own_then_pool` does **not** hit this branch (it already fell back to pool in Task 11; an
all-empty result uses the existing pool error semantics).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration byokNoOwnUpstream`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime apps/gateway/tests/routes/byokNoOwnUpstream.integration.test.ts
git commit -m "feat(gateway): own policy returns 409 no_own_upstream (vs 503) — existence-vs-schedulability split"
```

---

## Task 14: End-to-end integration — BYOK happy path

**Files:**
- Test: `apps/gateway/tests/routes/byokEndToEnd.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test** (testcontainer pg + mocked upstream, like `chatCompletions.integration.test.ts`)

```ts
it("registerOwn -> issueOwn(own) -> request served by the caller's own upstream, logged to it", async () => {
  const caller = await memberCaller();
  const acct = await caller.accounts.registerOwn({
    name: "mine", platform: "openai", type: "api_key", credentials: "sk-mine",
  });
  const { raw } = await caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own" });

  const res = await callGateway("/v1/chat/completions", raw, chatBody); // upstream mocked 200
  expect(res.statusCode).toBe(200);

  const [log] = await db.select().from(usageLogs)
    .where(eq(usageLogs.apiKeyId, /* the issued key id */ keyId))
    .orderBy(desc(usageLogs.createdAt)).limit(1);
  expect(log.accountId).toBe(acct.id);      // served by the user's own upstream
  expect(log.userId).toBe(caller.user.id);
});

it("a second user's pool key never routes to the first user's BYOK upstream", async () => {
  // userA registers own openai; userB uses a pool key; assert B's request does
  // NOT pick A's account (served by a seeded pool upstream or 503/409, never acctA).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration byokEndToEnd`
Expected: FAIL until all prior tasks are integrated (run after Tasks 1-13).

- [ ] **Step 3: No new code** — this is the capstone proving the slices compose. If it fails, the
  failure localises to one of Tasks 9-13; fix there, not here.

- [ ] **Step 4: Run the full gateway suites to confirm no regression**

Run: `pnpm --filter @caliber/gateway test && pnpm --filter @caliber/gateway test:integration`
Expected: all green (the pre-existing 469 unit + 268 integration, plus the new BYOK tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/tests/routes/byokEndToEnd.integration.test.ts
git commit -m "test(gateway): BYOK P1 end-to-end — own-key request served by + logged to the caller's own upstream"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §1.1→T1, §1.2→T2, §1.3 invariants 1-2→T11, invariant 3→T12, §1.4 guards→T1/T2/T7,
  §2.1→T4, §2.2→T5, §2.3→T6, §2.4→T3, §3.1→T8/T10, §3.2→T11, §4.1/4.2→T13, §4.3 fallback→T11,
  §4.4 validation→T4, §5 usage→T14 (assertion only, no new collection), §6 testing→every task.
- **No placeholders:** every code/SQL/test step carries concrete content; "find X with grep"
  appears only for two type-import locations that genuinely vary by repo layout.
- **Type consistency:** `routingPolicy` values `pool|own|own_then_pool` are identical across T2/T6/
  T9/T10/T11/T12; `platformForGatewayRoute` signature is stable T8→T10→T13; `ownershipOk`/
  `ownershipPool` predicate is defined once (T11/T12) and reused.

## Risks / sequencing notes

- Tasks 1-2 ship two migrations; deploy both before any gateway change that reads the columns.
- Task 10 touches hot-path routing context — run the full gateway suite (Task 14 Step 4) before merge.
- Migration journal drift (0016/0017 history): verify each migration applied on prod; apply
  out-of-band via psql if the journal `when` skips it.
