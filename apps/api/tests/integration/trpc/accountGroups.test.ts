import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { accountGroups, accountGroupMembers, upstreamAccounts } from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { accountGroupsRouter } from "../../../src/trpc/routers/accountGroups.js";

const localRouter = router({ accountGroups: accountGroupsRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(
  db: Database,
  userId: string,
  email = "x@x.test",
  env: ServerEnv = defaultTestEnv,
) {
  const perm = await resolvePermissions(db, userId);
  return createLocalCaller({
    db,
    user: { id: userId, email },
    perm,
    reqId: "test",
    locale: "en",
    env,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

async function makeAccount(
  db: Database,
  orgId: string,
  platform: "anthropic" | "openai" = "openai",
  name = "fixture",
) {
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name,
      platform,
      type: "api_key",
    })
    .returning();
  return row!;
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("accountGroups.list", () => {
  it("returns active groups for own org, FORBIDDEN cross-org", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });

    await t.db.insert(accountGroups).values([
      { orgId: orgA.id, name: "A1", platform: "openai" },
      { orgId: orgA.id, name: "A2", platform: "anthropic" },
      { orgId: orgB.id, name: "B1", platform: "openai" },
    ]);

    const caller = await callerFor(t.db, adminA.id);
    const list = await caller.accountGroups.list({ orgId: orgA.id });
    expect(list.map((g) => g.name).sort()).toEqual(["A1", "A2"]);
    await expect(
      caller.accountGroups.list({ orgId: orgB.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("excludes soft-deleted groups", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    await t.db.insert(accountGroups).values([
      { orgId: org.id, name: "alive", platform: "openai" },
      {
        orgId: org.id,
        name: "tombstoned",
        platform: "openai",
        deletedAt: new Date(),
      },
    ]);
    const caller = await callerFor(t.db, admin.id);
    const list = await caller.accountGroups.list({ orgId: org.id });
    expect(list.map((g) => g.name)).toEqual(["alive"]);
  });
});

describe("accountGroups.get", () => {
  it("returns group with hydrated member rows", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g1", platform: "openai" })
      .returning();
    const acct1 = await makeAccount(t.db, org.id, "openai", "k1");
    const acct2 = await makeAccount(t.db, org.id, "openai", "k2");
    await t.db.insert(accountGroupMembers).values([
      { groupId: group!.id, accountId: acct1.id, priority: 10 },
      { groupId: group!.id, accountId: acct2.id, priority: 20 },
    ]);

    const caller = await callerFor(t.db, admin.id);
    const got = await caller.accountGroups.get({ id: group!.id });
    expect(got.id).toBe(group!.id);
    expect(got.members).toHaveLength(2);
    const byName = new Map(got.members.map((m) => [m.accountName, m]));
    expect(byName.get("k1")?.priority).toBe(10);
    expect(byName.get("k2")?.priority).toBe(20);
    // `accountDeletedAt` is exposed so the UI can render tombstoned-but-
    // still-linked accounts; null for healthy ones.
    expect(byName.get("k1")?.accountDeletedAt).toBeNull();
    expect(byName.get("k2")?.accountDeletedAt).toBeNull();
  });

  it("get: surfaces accountDeletedAt for soft-deleted member accounts", async () => {
    // Membership row stays after the account is soft-deleted (FK only
    // cascades on hard delete); UI relies on this field to show a
    // "tombstoned" indicator instead of pretending the member is healthy.
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "ghosts", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "rip");
    await t.db.insert(accountGroupMembers).values({
      groupId: group!.id,
      accountId: acct.id,
      priority: 10,
    });
    const tombstone = new Date();
    await t.db
      .update(upstreamAccounts)
      .set({ deletedAt: tombstone })
      .where(eq(upstreamAccounts.id, acct.id));

    const caller = await callerFor(t.db, admin.id);
    const got = await caller.accountGroups.get({ id: group!.id });
    expect(got.members).toHaveLength(1);
    expect(got.members[0]?.accountDeletedAt).not.toBeNull();
    expect(got.members[0]?.accountName).toBe("rip");
  });

  it("NOT_FOUND for unknown id and for cross-org (no leak)", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const callerA = await callerFor(t.db, adminA.id);

    await expect(
      callerA.accountGroups.get({
        id: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [bGroup] = await t.db
      .insert(accountGroups)
      .values({ orgId: orgB.id, name: "B-secret", platform: "openai" })
      .returning();
    await expect(
      callerA.accountGroups.get({ id: bGroup!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("accountGroups.create", () => {
  it("happy path: inserts row with defaults applied", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    const created = await caller.accountGroups.create({
      orgId: org.id,
      name: "openai-prod-pool",
      platform: "openai",
    });
    expect(created).toMatchObject({
      orgId: org.id,
      name: "openai-prod-pool",
      platform: "openai",
      isExclusive: false,
      status: "active",
    });
    expect(created.rateMultiplier).toBe("1.0000");
    expect(created.description).toBeNull();
  });

  it("rejects duplicate (orgId, name) with BAD_REQUEST", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    await caller.accountGroups.create({
      orgId: org.id,
      name: "dupe",
      platform: "openai",
    });
    await expect(
      caller.accountGroups.create({
        orgId: org.id,
        name: "dupe",
        platform: "openai",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already exists"),
    });
  });

  it("forbids cross-org create", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor(t.db, adminA.id);
    await expect(
      caller.accountGroups.create({
        orgId: orgB.id,
        name: "x",
        platform: "openai",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("accountGroups.update", () => {
  it("happy path: applies patch", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "before", platform: "openai" })
      .returning();
    const caller = await callerFor(t.db, admin.id);

    const updated = await caller.accountGroups.update({
      id: group!.id,
      name: "after",
      description: "renamed",
      rateMultiplier: 0.5,
      isExclusive: true,
      status: "disabled",
    });
    expect(updated).toMatchObject({
      id: group!.id,
      name: "after",
      description: "renamed",
      isExclusive: true,
      status: "disabled",
    });
    expect(updated.rateMultiplier).toBe("0.5000");
  });

  it("rejects rename to a name already used in the same org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    await t.db
      .insert(accountGroups)
      .values([{ orgId: org.id, name: "taken", platform: "openai" }]);
    const [other] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "free", platform: "openai" })
      .returning();
    const caller = await callerFor(t.db, admin.id);
    await expect(
      caller.accountGroups.update({ id: other!.id, name: "taken" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already exists"),
    });
  });

  it("FORBIDDEN cross-org", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const [bGroup] = await t.db
      .insert(accountGroups)
      .values({ orgId: orgB.id, name: "B", platform: "openai" })
      .returning();
    const caller = await callerFor(t.db, adminA.id);
    await expect(
      caller.accountGroups.update({ id: bGroup!.id, name: "hijacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("accountGroups.delete", () => {
  it("soft-deletes group + hard-deletes membership rows", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "byebye", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "doomed");
    await t.db.insert(accountGroupMembers).values({
      groupId: group!.id,
      accountId: acct.id,
      priority: 50,
    });
    const caller = await callerFor(t.db, admin.id);

    const result = await caller.accountGroups.delete({ id: group!.id });
    expect(result).toEqual({ ok: true });

    const [row] = await t.db
      .select()
      .from(accountGroups)
      .where(
        and(
          eq(accountGroups.id, group!.id),
          isNotNull(accountGroups.deletedAt),
        ),
      );
    expect(row).toBeDefined();
    expect(row!.status).toBe("disabled");

    // Membership rows are hard-deleted alongside the soft-deleted group —
    // they're an optimisation table, not authoritative.
    const remainingMembers = await t.db
      .select()
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.groupId, group!.id));
    expect(remainingMembers).toHaveLength(0);

    // The underlying upstream_accounts row stays intact.
    const [stillThere] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(stillThere).toBeDefined();
    expect(stillThere!.deletedAt).toBeNull();
  });
});

describe("accountGroups.addMember", () => {
  it("happy path with default priority", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    const caller = await callerFor(t.db, admin.id);

    await caller.accountGroups.addMember({
      groupId: group!.id,
      accountId: acct.id,
    });
    const [row] = await t.db
      .select()
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.accountId, acct.id));
    expect(row).toMatchObject({
      groupId: group!.id,
      accountId: acct.id,
      priority: 50,
    });
  });

  it("respects explicit priority", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    const caller = await callerFor(t.db, admin.id);

    await caller.accountGroups.addMember({
      groupId: group!.id,
      accountId: acct.id,
      priority: 5,
    });
    const [row] = await t.db
      .select()
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.accountId, acct.id));
    expect(row!.priority).toBe(5);
  });

  it("rejects cross-org account", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: orgA.id, name: "g", platform: "openai" })
      .returning();
    const bAcct = await makeAccount(t.db, orgB.id, "openai", "from-B");
    const caller = await callerFor(t.db, admin.id);

    await expect(
      caller.accountGroups.addMember({
        groupId: group!.id,
        accountId: bAcct.id,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not belong"),
    });
  });

  it("rejects platform mismatch", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "anthropic", "antacct");
    const caller = await callerFor(t.db, admin.id);

    await expect(
      caller.accountGroups.addMember({
        groupId: group!.id,
        accountId: acct.id,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "validation.custom.accountGroups.accountPlatformMismatch#" +
        encodeURIComponent(
          JSON.stringify({
            accountPlatform: "anthropic",
            groupPlatform: "openai",
          }),
        ),
    });
  });

  it("rejects duplicate add", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    const caller = await callerFor(t.db, admin.id);

    await caller.accountGroups.addMember({
      groupId: group!.id,
      accountId: acct.id,
    });
    await expect(
      caller.accountGroups.addMember({
        groupId: group!.id,
        accountId: acct.id,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already a member"),
    });
  });

  it("NOT_FOUND when group is soft-deleted", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({
        orgId: org.id,
        name: "ghost",
        platform: "openai",
        deletedAt: new Date(),
      })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    const caller = await callerFor(t.db, admin.id);
    await expect(
      caller.accountGroups.addMember({
        groupId: group!.id,
        accountId: acct.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("accountGroups.removeMember", () => {
  it("happy path drops the membership row", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    await t.db.insert(accountGroupMembers).values({
      groupId: group!.id,
      accountId: acct.id,
      priority: 10,
    });
    const caller = await callerFor(t.db, admin.id);

    await caller.accountGroups.removeMember({
      groupId: group!.id,
      accountId: acct.id,
    });
    const rows = await t.db
      .select()
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.accountId, acct.id));
    expect(rows).toHaveLength(0);
  });

  it("NOT_FOUND when account isn't actually a member", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "lonely");
    const caller = await callerFor(t.db, admin.id);
    await expect(
      caller.accountGroups.removeMember({
        groupId: group!.id,
        accountId: acct.id,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("not a member"),
    });
  });
});

describe("accountGroups.setMemberPriority", () => {
  it("happy path updates priority", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "m1");
    await t.db.insert(accountGroupMembers).values({
      groupId: group!.id,
      accountId: acct.id,
      priority: 50,
    });
    const caller = await callerFor(t.db, admin.id);

    await caller.accountGroups.setMemberPriority({
      groupId: group!.id,
      accountId: acct.id,
      priority: 5,
    });
    const [row] = await t.db
      .select()
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.accountId, acct.id));
    expect(row!.priority).toBe(5);
  });

  it("NOT_FOUND for a non-member", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [group] = await t.db
      .insert(accountGroups)
      .values({ orgId: org.id, name: "g", platform: "openai" })
      .returning();
    const acct = await makeAccount(t.db, org.id, "openai", "ghost");
    const caller = await callerFor(t.db, admin.id);
    await expect(
      caller.accountGroups.setMemberPriority({
        groupId: group!.id,
        accountId: acct.id,
        priority: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
