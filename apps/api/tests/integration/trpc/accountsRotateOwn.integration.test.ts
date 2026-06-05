import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { credentialVault, upstreamAccounts, auditLogs } from "@caliber/db";
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

describe("accounts.rotateOwn", () => {
  it("rotateOwn replaces vault ciphertext in-place, keeps same account id, and sets rotatedAt", async () => {
    const { caller } = await memberCaller();

    // Register an upstream to get an account id and initial vault row
    const acct = await caller.accounts.registerOwn({
      name: "my openai",
      platform: "openai",
      type: "api_key",
      credentials: "sk-original-secret",
    });

    // Capture the initial vault state
    const [vaultBefore] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultBefore).toBeDefined();
    const ciphertextBefore = vaultBefore!.ciphertext;
    const nonceBefore = vaultBefore!.nonce;

    // Rotate with a new secret
    const result = await caller.accounts.rotateOwn({
      id: acct.id,
      credentials: "sk-rotated-secret",
    });

    // The returned id must be the same account id
    expect(result.id).toBe(acct.id);

    // Fetch vault rows after rotation
    const vaultRowsAfter = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));

    // Must still be exactly one vault row (no duplicate insert)
    expect(vaultRowsAfter).toHaveLength(1);

    const vaultAfter = vaultRowsAfter[0]!;

    // Ciphertext and nonce must have changed (new secret → new encryption)
    expect(Buffer.compare(vaultAfter.ciphertext, ciphertextBefore)).not.toBe(0);
    expect(Buffer.compare(vaultAfter.nonce, nonceBefore)).not.toBe(0);

    // rotatedAt must be set
    expect(vaultAfter.rotatedAt).not.toBeNull();
    expect(vaultAfter.rotatedAt).toBeInstanceOf(Date);

    // result.rotatedAt should match vault rotatedAt (within 1s tolerance)
    expect(Math.abs(result.rotatedAt.getTime() - vaultAfter.rotatedAt!.getTime())).toBeLessThan(1000);
  });

  it("rotateOwn does not change the upstream_accounts row id, userId, platform, or type", async () => {
    const { caller, user } = await memberCaller();

    const acct = await caller.accounts.registerOwn({
      name: "anthropic key",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-ant-original",
    });

    await caller.accounts.rotateOwn({
      id: acct.id,
      credentials: "sk-ant-rotated",
    });

    const [row] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));

    expect(row).toBeDefined();
    expect(row!.id).toBe(acct.id);
    expect(row!.userId).toBe(user.id);
    expect(row!.platform).toBe("anthropic");
    expect(row!.type).toBe("api_key");
    expect(row!.deletedAt).toBeNull();
  });

  it("rotateOwn writes an audit log entry", async () => {
    const { caller, user } = await memberCaller();

    const acct = await caller.accounts.registerOwn({
      name: "audit test key",
      platform: "openai",
      type: "api_key",
      credentials: "sk-audit-original",
    });

    await caller.accounts.rotateOwn({
      id: acct.id,
      credentials: "sk-audit-rotated",
    });

    const [auditRow] = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, acct.id),
          eq(auditLogs.action, "account.rotated_own"),
        ),
      )
      .limit(1);

    expect(auditRow).toBeDefined();
    expect(auditRow!.actorUserId).toBe(user.id);
    expect(auditRow!.targetType).toBe("upstream_account");
  });

  it("rotateOwn on another user's account rejects with NOT_FOUND", async () => {
    const a = await memberCaller();
    const b = await memberCaller();

    const mine = await a.caller.accounts.registerOwn({
      name: "a-key",
      platform: "openai",
      type: "api_key",
      credentials: "sk-a-original",
    });

    // User B tries to rotate user A's account
    await expect(
      b.caller.accounts.rotateOwn({
        id: mine.id,
        credentials: "sk-b-hijack",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Ensure the vault row was not modified
    const [vault] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, mine.id));
    expect(vault!.rotatedAt).toBeNull();
  });

  it("rotateOwn rejects empty credentials", async () => {
    const { caller } = await memberCaller();

    const acct = await caller.accounts.registerOwn({
      name: "x",
      platform: "openai",
      type: "api_key",
      credentials: "sk-original",
    });

    await expect(
      caller.accounts.rotateOwn({
        id: acct.id,
        credentials: "",
      }),
    ).rejects.toThrow();
  });

  it("rotateOwn on a non-existent account id rejects with NOT_FOUND", async () => {
    const { caller } = await memberCaller();

    await expect(
      caller.accounts.rotateOwn({
        id: "00000000-0000-0000-0000-000000000000",
        credentials: "sk-ghost",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
