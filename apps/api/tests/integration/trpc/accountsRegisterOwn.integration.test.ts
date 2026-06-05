import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { credentialVault, upstreamAccounts } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  defaultTestEnv,
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

describe("accounts.registerOwn", () => {
  it("registerOwn stores a user-owned api_key upstream + encrypted vault row", async () => {
    const { caller, user } = await memberCaller();

    const acct = await caller.accounts.registerOwn({
      name: "my openai",
      platform: "openai",
      type: "api_key",
      credentials: "sk-test-123",
    });

    expect(acct.userId).toBe(user.id);
    expect(acct.teamId).toBeNull();

    const vault = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vault).toHaveLength(1);
    expect(vault[0]!.nonce).toBeTruthy();
    expect(vault[0]!.ciphertext).toBeTruthy();
    expect(vault[0]!.authTag).toBeTruthy();
  });

  it("registerOwn sets orgId to the caller's primary org and teamId to null", async () => {
    const { caller, user, org } = await memberCaller();

    const acct = await caller.accounts.registerOwn({
      name: "anthropic key",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-ant-test-abc",
    });

    expect(acct.orgId).toBe(org.id);
    expect(acct.userId).toBe(user.id);
    expect(acct.teamId).toBeNull();
    expect(acct.type).toBe("api_key");
    expect(acct.platform).toBe("anthropic");
  });

  it("registerOwn rejects an empty credential", async () => {
    const { caller } = await memberCaller();
    await expect(
      caller.accounts.registerOwn({
        name: "x",
        platform: "openai",
        type: "api_key",
        credentials: "",
      }),
    ).rejects.toThrow();
  });

  it("registerOwn returns NOT_FOUND when ENABLE_GATEWAY=false", async () => {
    const { user } = await memberCaller();
    const disabledCaller = await callerFor(t.db, user.id, undefined, {
      ...defaultTestEnv,
      ENABLE_GATEWAY: false,
    });
    await expect(
      disabledCaller.accounts.registerOwn({
        name: "x",
        platform: "openai",
        type: "api_key",
        credentials: "sk-test",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
