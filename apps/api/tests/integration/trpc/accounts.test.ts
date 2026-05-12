import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { credentialVault, upstreamAccounts } from "@caliber/db";
import { decryptCredential } from "@caliber/gateway-core";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeTeam,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { accountsRouter } from "../../../src/trpc/routers/accounts.js";

// Local sub-router so this test can run independently of Task 8.4 (which
// wires `accounts` into the global appRouter). Strictly typed against the
// real accountsRouter — no `as any` needed.
const localRouter = router({ accounts: accountsRouter });
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
    env,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("accounts router", () => {
  it("list: org_admin sees own org accounts but not other orgs", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor(t.db, admin.id);

    await caller.accounts.create({
      orgId: orgA.id,
      name: "A1",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-test-aaa",
    });

    // Insert an account directly into orgB so the admin can't see it.
    await t.db.insert(upstreamAccounts).values({
      orgId: orgB.id,
      name: "B1",
      platform: "anthropic",
      type: "api_key",
    });

    const list = await caller.accounts.list({ orgId: orgA.id });
    expect(list.map((r) => r.name)).toEqual(["A1"]);
    await expect(
      caller.accounts.list({ orgId: orgB.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("list: optional platform filter narrows server-side", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    // Insert via DB directly so this test stays decoupled from the
    // accounts.create platformEnum widening (lives on the parallel
    // phase1 branch); we only need rows of distinct platforms to verify
    // the SELECT WHERE clause picks them up.
    await t.db.insert(upstreamAccounts).values([
      { orgId: org.id, name: "ant", platform: "anthropic", type: "api_key" },
      { orgId: org.id, name: "oai", platform: "openai", type: "api_key" },
    ]);

    const all = await caller.accounts.list({ orgId: org.id });
    expect(all.map((r) => r.name).sort()).toEqual(["ant", "oai"]);

    const onlyOpenai = await caller.accounts.list({
      orgId: org.id,
      platform: "openai",
    });
    expect(onlyOpenai.map((r) => r.name)).toEqual(["oai"]);

    const onlyAnthropic = await caller.accounts.list({
      orgId: org.id,
      platform: "anthropic",
    });
    expect(onlyAnthropic.map((r) => r.name)).toEqual(["ant"]);
  });

  it("get: NOT_FOUND for unknown id and unauthorized id", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const callerA = await callerFor(t.db, adminA.id);

    // Random uuid → NOT_FOUND
    await expect(
      callerA.accounts.get({ id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Account exists in orgB; adminA can't see it → NOT_FOUND (no leak).
    const [bAcct] = await t.db
      .insert(upstreamAccounts)
      .values({
        orgId: orgB.id,
        name: "B-secret",
        platform: "anthropic",
        type: "api_key",
      })
      .returning();
    await expect(callerA.accounts.get({ id: bAcct!.id })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );

    // Account in orgA → success.
    const created = await callerA.accounts.create({
      orgId: orgA.id,
      name: "A-visible",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-visible",
    });
    const got = await callerA.accounts.get({ id: created.id });
    expect(got.name).toBe("A-visible");
  });

  it("create: api_key path inserts both rows; oauth path persists oauthExpiresAt", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    const apiKeyAcct = await caller.accounts.create({
      orgId: org.id,
      name: "apikey-acct",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-ant-rotate-1",
    });
    const [vault1] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, apiKeyAcct.id));
    expect(vault1).toBeDefined();
    expect(vault1!.oauthExpiresAt).toBeNull();
    // Roundtrip-decrypt to prove the cipher worked end-to-end.
    const plain = decryptCredential({
      masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
      accountId: apiKeyAcct.id,
      sealed: {
        nonce: vault1!.nonce,
        ciphertext: vault1!.ciphertext,
        authTag: vault1!.authTag,
      },
      version: 2,
    });
    // accounts.create wraps the raw UI-supplied credential with the gateway
    // envelope ({type, api_key}) so resolveCredential can discriminate on
    // type at the gateway side. See buildCredentialPlaintext in accounts.ts.
    expect(JSON.parse(plain)).toEqual({
      type: "api_key",
      api_key: "sk-ant-rotate-1",
    });

    const expiresIso = new Date(Date.now() + 3600_000).toISOString();
    const oauthAcct = await caller.accounts.create({
      orgId: org.id,
      name: "oauth-acct",
      platform: "anthropic",
      type: "oauth",
      credentials: JSON.stringify({
        access_token: "a",
        refresh_token: "r",
        expires_at: expiresIso,
      }),
    });
    const [vault2] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, oauthAcct.id));
    expect(vault2!.oauthExpiresAt).not.toBeNull();
    expect(vault2!.oauthExpiresAt!.toISOString()).toBe(expiresIso);
  });

  it("create: oauth expires_at as unix-ms gets normalised to ISO before encryption (closes #73)", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    // Operator pastes the bundle exactly as it comes out of the
    // claude-code keychain extract one-liner — `expires_at` as a
    // unix-millisecond integer (the form hint historically didn't
    // require ISO). Pre-#73, the gateway rejected this at runtime
    // with `CredentialFormatError`.
    const expiresMs = Date.now() + 3600_000;
    const expectedIso = new Date(expiresMs).toISOString();

    const acct = await caller.accounts.create({
      orgId: org.id,
      name: "oauth-acct-unix-ms",
      platform: "anthropic",
      type: "oauth",
      credentials: JSON.stringify({
        access_token: "sk-ant-oat01-test",
        refresh_token: "sk-ant-ort01-test",
        expires_at: expiresMs,
      }),
    });

    const [vault] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));

    // Column-side normalisation: vault.oauthExpiresAt is the parsed Date.
    expect(vault!.oauthExpiresAt!.getTime()).toBe(expiresMs);

    // Encrypted-payload normalisation (the actual #73 regression).
    const plain = decryptCredential({
      masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
      accountId: acct.id,
      sealed: {
        nonce: vault!.nonce,
        ciphertext: vault!.ciphertext,
        authTag: vault!.authTag,
      },
      version: 2,
    });
    const decoded = JSON.parse(plain);
    // Stored as ISO, not as the unix-ms integer the user pasted —
    // matches what gateway/runtime/resolveCredential expects.
    expect(decoded.expires_at).toBe(expectedIso);
    expect(decoded.type).toBe("oauth");
  });

  it("create: oauth expires_at as unix-seconds also gets normalised (closes #73)", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    // Same path, seconds variant — parseOauthExpiresAt's heuristic
    // treats values < 1e12 as seconds.
    const expiresSec = Math.floor(Date.now() / 1000) + 3600;
    const expectedIso = new Date(expiresSec * 1000).toISOString();

    const acct = await caller.accounts.create({
      orgId: org.id,
      name: "oauth-acct-unix-sec",
      platform: "anthropic",
      type: "oauth",
      credentials: JSON.stringify({
        access_token: "x",
        refresh_token: "y",
        expires_at: expiresSec,
      }),
    });

    const [vault] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    const plain = decryptCredential({
      masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
      accountId: acct.id,
      sealed: {
        nonce: vault!.nonce,
        ciphertext: vault!.ciphertext,
        authTag: vault!.authTag,
      },
      version: 2,
    });
    expect(JSON.parse(plain).expires_at).toBe(expectedIso);
  });

  it("create: openai platform with api_key persists row + decrypts roundtrip", async () => {
    // API-key migration plan Phase 1 — verify the openai platform widening
    // accepts `sk-...` keys end-to-end. The gateway upstreamCallOpenai
    // already authenticates api_key creds via Authorization: Bearer, so no
    // gateway-side change is needed for this to function at runtime.
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    const acct = await caller.accounts.create({
      orgId: org.id,
      name: "openai-prod-1",
      platform: "openai",
      type: "api_key",
      credentials: "sk-proj-test-12345",
    });
    expect(acct.platform).toBe("openai");
    expect(acct.type).toBe("api_key");

    const [vault] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vault).toBeDefined();
    expect(vault!.oauthExpiresAt).toBeNull();
    const plain = decryptCredential({
      masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
      accountId: acct.id,
      sealed: {
        nonce: vault!.nonce,
        ciphertext: vault!.ciphertext,
        authTag: vault!.authTag,
      },
      version: 2,
    });
    expect(JSON.parse(plain)).toEqual({
      type: "api_key",
      api_key: "sk-proj-test-12345",
    });
  });

  it("create: rejects unknown platform values at the validation layer", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);

    await expect(
      caller.accounts.create({
        orgId: org.id,
        name: "rogue",
        // @ts-expect-error — assertion: Zod rejects unrecognized platforms.
        platform: "gemini",
        type: "api_key",
        credentials: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("create: teamId from a different org → FORBIDDEN (team-org binding guard)", async () => {
    // org_admin in orgA passes RBAC for creating an account in orgA but
    // pins teamId belonging to orgB. Without the team-org check the row
    // would land with org_id=A and team_id=<orgB team>, corrupting
    // team-scoped routing and usage attribution.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const teamInB = await makeTeam(t.db, orgB.id);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor(t.db, admin.id);

    await expect(
      caller.accounts.create({
        orgId: orgA.id,
        teamId: teamInB.id,
        name: "x-org-team",
        platform: "anthropic",
        type: "api_key",
        credentials: "sk-x",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("team does not belong to org"),
    });
  });

  it("create: returns NOT_FOUND when ENABLE_GATEWAY=false", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id, undefined, {
      ...defaultTestEnv,
      ENABLE_GATEWAY: false,
    });
    await expect(
      caller.accounts.create({
        orgId: org.id,
        name: "x",
        platform: "anthropic",
        type: "api_key",
        credentials: "sk-x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("update: patches name/priority for own org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "before",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-before",
    });

    const updated = await caller.accounts.update({
      id: created.id,
      name: "after",
      priority: 99,
    });
    expect(updated.name).toBe("after");
    expect(updated.priority).toBe(99);
  });

  it("update: returns FORBIDDEN when caller is org_admin on a different org", async () => {
    const org = await makeOrg(t.db);
    const otherOrg = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const otherAdmin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: otherOrg.id,
      orgId: otherOrg.id,
    });

    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "mine",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-mine",
    });

    const otherCaller = await callerFor(t.db, otherAdmin.id);
    await expect(
      otherCaller.accounts.update({ id: created.id, name: "pwned" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rotate: changes ciphertext and sets rotatedAt", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "rotate-me",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-original",
    });

    const [before] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, created.id));
    expect(before!.rotatedAt).toBeNull();

    const result = await caller.accounts.rotate({
      id: created.id,
      credentials: "sk-new-secret",
    });
    expect(result.id).toBe(created.id);
    expect(result.rotatedAt).toBeInstanceOf(Date);

    const [after] = await t.db
      .select()
      .from(credentialVault)
      .where(eq(credentialVault.accountId, created.id));
    expect(after!.ciphertext.equals(before!.ciphertext)).toBe(false);
    expect(after!.rotatedAt).not.toBeNull();
    const decrypted = decryptCredential({
      masterKeyHex: defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!,
      accountId: created.id,
      sealed: {
        nonce: after!.nonce,
        ciphertext: after!.ciphertext,
        authTag: after!.authTag,
      },
      version: 2,
    });
    // rotate wraps the same way create does — see buildCredentialPlaintext.
    expect(JSON.parse(decrypted)).toEqual({
      type: "api_key",
      api_key: "sk-new-secret",
    });
  });

  it("rotate: throws NOT_FOUND when credential_vault row is missing", async () => {
    // Mimic legacy/partially-migrated data: insert an upstream_accounts row
    // directly WITHOUT the corresponding credential_vault row. Before the
    // .returning() check, rotate would silently no-op and report success.
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const [bareAcct] = await t.db
      .insert(upstreamAccounts)
      .values({
        orgId: org.id,
        name: "no-vault",
        platform: "anthropic",
        type: "api_key",
      })
      .returning();

    const caller = await callerFor(t.db, admin.id);
    await expect(
      caller.accounts.rotate({
        id: bareAcct!.id,
        credentials: "sk-rotate-nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rotate: returns FORBIDDEN when caller is org_admin on a different org", async () => {
    const org = await makeOrg(t.db);
    const otherOrg = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const otherAdmin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: otherOrg.id,
      orgId: otherOrg.id,
    });

    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "rotate-mine",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-rotate-mine",
    });

    const otherCaller = await callerFor(t.db, otherAdmin.id);
    await expect(
      otherCaller.accounts.rotate({
        id: created.id,
        credentials: "sk-pwned",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("delete: returns FORBIDDEN when caller is org_admin on a different org", async () => {
    const org = await makeOrg(t.db);
    const otherOrg = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const otherAdmin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: otherOrg.id,
      orgId: otherOrg.id,
    });

    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "delete-mine",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-delete-mine",
    });

    const otherCaller = await callerFor(t.db, otherAdmin.id);
    await expect(
      otherCaller.accounts.delete({ id: created.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("delete: soft-deletes and excludes from subsequent list", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    const created = await caller.accounts.create({
      orgId: org.id,
      name: "delete-me",
      platform: "anthropic",
      type: "api_key",
      credentials: "sk-bye",
    });

    const beforeList = await caller.accounts.list({ orgId: org.id });
    expect(beforeList.some((r) => r.id === created.id)).toBe(true);

    const res = await caller.accounts.delete({ id: created.id });
    expect(res.ok).toBe(true);

    const afterList = await caller.accounts.list({ orgId: org.id });
    expect(afterList.some((r) => r.id === created.id)).toBe(false);

    const [row] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(and(eq(upstreamAccounts.id, created.id)));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.schedulable).toBe(false);
  });
});
