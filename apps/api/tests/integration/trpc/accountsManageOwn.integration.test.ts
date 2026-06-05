import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { upstreamAccounts, auditLogs } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

/**
 * Seed a member user (org_member role) with a primary org and return the
 * tRPC caller alongside the seeded user record.
 */
async function memberCaller() {
  const org = await makeOrg(t.db);
  const user = await makeUser(t.db, {
    role: "member",
    scopeType: "organization",
    scopeId: org.id,
    orgId: org.id,
  });
  const caller = await callerFor(t.db, user.id);
  return { caller, user, org, db: t.db };
}

describe("accounts.listOwn / updateOwn / deleteOwn", () => {
  it("listOwn returns only the caller's upstreams", async () => {
    const a = await memberCaller();
    const b = await memberCaller();
    const mine = await a.caller.accounts.registerOwn({
      name: "a",
      platform: "openai",
      type: "api_key",
      credentials: "sk-a",
    });
    await b.caller.accounts.registerOwn({
      name: "b",
      platform: "openai",
      type: "api_key",
      credentials: "sk-b",
    });
    const list = await a.caller.accounts.listOwn();
    expect(list.map((r) => r.id)).toEqual([mine.id]);
  });

  it("updateOwn changes metadata but not credential, and only the owner's row", async () => {
    const a = await memberCaller();
    const b = await memberCaller();
    const mine = await a.caller.accounts.registerOwn({
      name: "a",
      platform: "openai",
      type: "api_key",
      credentials: "sk-a",
    });
    const upd = await a.caller.accounts.updateOwn({
      id: mine.id,
      name: "renamed",
      schedulable: false,
    });
    expect(upd.name).toBe("renamed");
    expect(upd.schedulable).toBe(false);
    await expect(
      b.caller.accounts.updateOwn({ id: mine.id, name: "hijack" }),
    ).rejects.toThrow();

    // Audit row should have been written for the successful update
    const [auditRow] = await a.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, mine.id),
          eq(auditLogs.action, "account.updated_own"),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow!.actorUserId).toBe(a.user.id);
  });

  it("deleteOwn soft-deletes only the caller's row", async () => {
    const a = await memberCaller();
    const b = await memberCaller();
    const mine = await a.caller.accounts.registerOwn({
      name: "a",
      platform: "openai",
      type: "api_key",
      credentials: "sk-a",
    });
    await expect(
      b.caller.accounts.deleteOwn({ id: mine.id }),
    ).rejects.toThrow();
    await a.caller.accounts.deleteOwn({ id: mine.id });
    const [row] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, mine.id));
    expect(row!.deletedAt).not.toBeNull();

    // Audit row should have been written for the soft-delete
    const [auditRow] = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, mine.id),
          eq(auditLogs.action, "account.deleted_own"),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow!.actorUserId).toBe(a.user.id);
  });
});
