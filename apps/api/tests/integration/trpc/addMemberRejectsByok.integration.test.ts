import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { accountGroups, upstreamAccounts } from "@caliber/db";
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
 * Make an org-admin caller, returning the caller, the user record, and the org.
 */
async function orgAdminCaller() {
  const org = await makeOrg(t.db);
  const user = await makeUser(t.db, {
    role: "org_admin",
    scopeType: "organization",
    scopeId: org.id,
    orgId: org.id,
  });
  const caller = await callerFor(t.db, user.id);
  return { caller, user, org };
}

/**
 * Make a member caller scoped to an existing org.
 */
async function memberCallerInOrg(orgId: string) {
  const user = await makeUser(t.db, {
    role: "member",
    scopeType: "organization",
    scopeId: orgId,
    orgId,
  });
  const caller = await callerFor(t.db, user.id);
  return { caller, user };
}

describe("accountGroups.addMember — BYOK guard", () => {
  it("rejects an upstream that is user-owned (userId IS NOT NULL)", async () => {
    const admin = await orgAdminCaller();
    const member = await memberCallerInOrg(admin.org.id);

    // Member registers their own BYOK upstream (userId is set by registerOwn)
    const byok = await member.caller.accounts.registerOwn({
      name: "byok-openai",
      platform: "openai",
      type: "api_key",
      credentials: "sk-x-test",
    });

    // Admin creates a pool group in the same org
    const group = await admin.caller.accountGroups.create({
      orgId: admin.org.id,
      name: "openai-pool",
      platform: "openai",
    });

    // Attempt to add the BYOK upstream to the pool group — must be rejected
    await expect(
      admin.caller.accountGroups.addMember({ groupId: group.id, accountId: byok.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/user-owned|BYOK|cannot be added/i),
    });
  });

  it("positive control: adding a pool upstream (userId null) succeeds", async () => {
    const admin = await orgAdminCaller();

    // Insert a pool upstream directly (no userId — simulates an admin-managed key)
    const [poolAcct] = await t.db
      .insert(upstreamAccounts)
      .values({
        orgId: admin.org.id,
        name: "pool-key",
        platform: "openai",
        type: "api_key",
        // userId intentionally omitted → null
      })
      .returning();

    const group = await admin.caller.accountGroups.create({
      orgId: admin.org.id,
      name: "openai-pool-ctrl",
      platform: "openai",
    });

    // Should succeed — pool upstream has userId = null
    const result = await admin.caller.accountGroups.addMember({
      groupId: group.id,
      accountId: poolAcct!.id,
    });
    expect(result).toEqual({ ok: true });
  });
});
