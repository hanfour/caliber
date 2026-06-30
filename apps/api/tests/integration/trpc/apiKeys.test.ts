import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import { apiKeys, accountGroups, auditLogs } from "@caliber/db";
import { verifyApiKey } from "@caliber/gateway-core";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeTeam,
  makeUser,
  defaultTestEnv,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { apiKeysRouter } from "../../../src/trpc/routers/apiKeys.js";

// Local sub-router so this test runs independently of Task 8.4 (which
// wires `apiKeys` into the global appRouter).
const localRouter = router({ apiKeys: apiKeysRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: {
  db: Database;
  userId: string;
  redis: Redis;
  email?: string;
  env?: ServerEnv;
  ipAddress?: string | null;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: opts.redis,
    ipAddress: opts.ipAddress ?? null,
    logger: noopTestLogger,
  });
}

// HMAC must mirror the router's hashRevealToken — keep this in sync if the
// algorithm changes. Tests assert the on-wire Redis key shape directly.
function hashRevealToken(pepperHex: string, token: string): string {
  return createHmac("sha256", Buffer.from(pepperHex, "hex"))
    .update(token)
    .digest("hex");
}

let t: Awaited<ReturnType<typeof setupTestDb>>;
let redis: Redis;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(() => {
  // Fresh in-memory store per test so reveal-token stashes don't leak between
  // cases. Mirrors gateway tests' pattern.
  redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
});

describe("apiKeys router", () => {
  it("issueOwn: returns raw + id, persists hashed keyHash, verifyApiKey roundtrips", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });

    const result = await caller.apiKeys.issueOwn({ name: "my-key" });
    expect(result.id).toBeTruthy();
    expect(result.raw).toMatch(/^ak_/);
    expect(result.prefix).toBe(result.raw.slice(0, 8));

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row).toBeDefined();
    // The persisted hash is NOT the raw value.
    expect(row!.keyHash).not.toBe(result.raw);
    // Roundtrip: hashing the raw with the same pepper matches the stored hash.
    expect(
      verifyApiKey(
        defaultTestEnv.API_KEY_HASH_PEPPER!,
        result.raw,
        row!.keyHash,
      ),
    ).toBe(true);
    expect(row!.userId).toBe(user.id);
    expect(row!.orgId).toBe(org.id);
    expect(row!.issuedByUserId).toBeNull();
    expect(row!.revealTokenHash).toBeNull();
  });

  it("issueOwn: NOT_FOUND when ENABLE_GATEWAY=false", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({
      db: t.db,
      userId: user.id,
      redis,
      env: { ...defaultTestEnv, ENABLE_GATEWAY: false },
    });
    await expect(caller.apiKeys.issueOwn({ name: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("issueForUser: returns revealUrl (no raw); persists revealTokenHash; redis stash holds raw under caliber:gw:key-reveal:<token>", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id, redis });

    const result = await caller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "admin-issued",
    });
    expect(result.id).toBeTruthy();
    expect(result.prefix).toMatch(/^ak_/);
    // Admin must NOT see the raw key.
    expect(result).not.toHaveProperty("raw");
    // URL shape is `{NEXTAUTH_URL}/api-keys/reveal/<token>` — the reveal page
    // is a web route, served from the dashboard origin, not the gateway (#192).
    expect(result.revealUrl.startsWith(defaultTestEnv.NEXTAUTH_URL)).toBe(true);
    expect(result.revealUrl).toContain("/api-keys/reveal/");
    const token = result.revealUrl.split("/").pop()!;
    expect(token.length).toBeGreaterThan(20);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row!.userId).toBe(target.id);
    expect(row!.issuedByUserId).toBe(admin.id);
    expect(row!.revealTokenHash).toBe(
      hashRevealToken(defaultTestEnv.API_KEY_HASH_PEPPER!, token),
    );
    expect(row!.revealTokenExpiresAt).not.toBeNull();
    expect(row!.revealedAt).toBeNull();

    // Verify the Redis stash is in the gateway namespace. ioredis-mock
    // exposes keys via the `data` map keyed by the *prefixed* string.
    // Asking the prefixed mock for the suffix returns the raw value.
    const stashed = await redis.get(`key-reveal:${token}`);
    expect(stashed).not.toBeNull();
    expect(stashed!.startsWith("ak_")).toBe(true);
  });

  it("issueForUser: targetUser is not a member of orgId → FORBIDDEN (cross-tenant credential issuance guard)", async () => {
    // org_admin in orgA tries to issue a key for a user who only belongs to
    // orgB. RBAC alone passes (admin in orgA), but the membership check
    // must reject — otherwise the targeted user could later claim the
    // reveal URL and hold a credential attributed to an org they don't
    // belong to.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const userInB = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminA.id, redis });

    await expect(
      caller.apiKeys.issueForUser({
        orgId: orgA.id,
        targetUserId: userInB.id,
        name: "x",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("member"),
    });
  });

  it("issueOwn: teamId from a different org → FORBIDDEN (team-org binding guard)", async () => {
    // Member in orgA self-issues a key but pins teamId belonging to orgB.
    // Without the team-org check, the row would land with org_id=A and
    // team_id=<orgB team>, corrupting team-scoped routing.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const teamInB = await makeTeam(t.db, orgB.id);
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: member.id, redis });

    await expect(
      caller.apiKeys.issueOwn({ name: "x", teamId: teamInB.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("team does not belong to org"),
    });
  });

  it("issueForUser: teamId from a different org → FORBIDDEN (team-org binding guard)", async () => {
    // org_admin in orgA targets a member of orgA (membership check passes)
    // but supplies teamId that lives in orgB. The team-org check must
    // reject so the inserted row can't cross-bind org and team.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const teamInB = await makeTeam(t.db, orgB.id);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const targetA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminA.id, redis });

    await expect(
      caller.apiKeys.issueForUser({
        orgId: orgA.id,
        targetUserId: targetA.id,
        name: "x",
        teamId: teamInB.id,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("team does not belong to org"),
    });
  });

  it("issueForUser: org_admin from a different org is FORBIDDEN", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const targetA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminB.id, redis });

    await expect(
      caller.apiKeys.issueForUser({
        orgId: orgA.id,
        targetUserId: targetA.id,
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revealViaToken: valid token returns raw, sets revealedAt + revealedByIp, deletes redis key", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "to-be-revealed",
    });
    const token = issued.revealUrl.split("/").pop()!;

    // Target user claims the URL (with a known IP for the audit assertion).
    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
      ipAddress: "203.0.113.7",
    });
    const result = await targetCaller.apiKeys.revealViaToken({ token });
    expect(result.id).toBe(issued.id);
    expect(result.raw.startsWith("ak_")).toBe(true);
    expect(result.name).toBe("to-be-revealed");

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.revealedAt).not.toBeNull();
    // inet column: drizzle returns it as the textual representation.
    expect(row!.revealedByIp).toBe("203.0.113.7");

    // Redis stash deleted.
    expect(await redis.get(`key-reveal:${token}`)).toBeNull();
  });

  it("revealViaToken: invalid token → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    await expect(
      caller.apiKeys.revealViaToken({ token: "not-a-real-token" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revealViaToken: token reused after successful reveal → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "single-use",
    });
    const token = issued.revealUrl.split("/").pop()!;
    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
    });

    await targetCaller.apiKeys.revealViaToken({ token });
    await expect(
      targetCaller.apiKeys.revealViaToken({ token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revealViaToken: token whose DB window has expired → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "expired",
    });
    const token = issued.revealUrl.split("/").pop()!;
    // Backdate the DB row's expiration window so the SELECT predicate fails,
    // simulating the 24h TTL elapsing without changing test wall-clock.
    await t.db
      .update(apiKeys)
      .set({ revealTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apiKeys.id, issued.id));

    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
    });
    await expect(
      targetCaller.apiKeys.revealViaToken({ token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revealViaToken: a different authenticated user (not the targetUser) → NOT_FOUND; targetUser can still claim afterwards", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const targetA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    // Same-org colleague, also a member — has a valid session but is NOT the
    // intended recipient. Must not be able to claim the misdirected URL.
    const userB = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: targetA.id,
      name: "scoped-to-targetA",
    });
    const token = issued.revealUrl.split("/").pop()!;

    // Wrong user attempts to claim → NOT_FOUND (no existence leak; userB
    // can't tell the token is valid for someone else).
    const callerB = await callerFor({ db: t.db, userId: userB.id, redis });
    await expect(
      callerB.apiKeys.revealViaToken({ token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The CAS predicate also requires revealedAt IS NULL — userB's failed
    // attempt must NOT have flipped revealedAt, so the targetUser can still
    // claim the URL successfully.
    const callerA = await callerFor({
      db: t.db,
      userId: targetA.id,
      redis,
    });
    const result = await callerA.apiKeys.revealViaToken({ token });
    expect(result.id).toBe(issued.id);
    expect(result.raw.startsWith("ak_")).toBe(true);
  });

  it("listOwn: returns only the caller's keys and excludes revoked rows", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const b = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const callerA = await callerFor({ db: t.db, userId: a.id, redis });
    const callerB = await callerFor({ db: t.db, userId: b.id, redis });

    const k1 = await callerA.apiKeys.issueOwn({ name: "a-1" });
    await callerA.apiKeys.issueOwn({ name: "a-2-revoked" });
    await callerB.apiKeys.issueOwn({ name: "b-1" });

    // Revoke A's second key directly (not via the revoke endpoint, which
    // we cover in its own test).
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, a.id), eq(apiKeys.name, "a-2-revoked")));

    const list = await callerA.apiKeys.listOwn();
    expect(list.map((r) => r.name).sort()).toEqual(["a-1"]);
    expect(list[0]!.id).toBe(k1.id);
    // No key material in the response.
    expect(list[0]).not.toHaveProperty("keyHash");
    expect(list[0]).not.toHaveProperty("raw");
    expect(list[0]).not.toHaveProperty("revealTokenHash");
    expect(list[0]).not.toHaveProperty("revealedByIp");
  });

  it("listOrg: org_admin sees all org keys; non-admin → FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const memberCaller = await callerFor({
      db: t.db,
      userId: member.id,
      redis,
    });

    await adminCaller.apiKeys.issueOwn({ name: "admin-key" });
    await memberCaller.apiKeys.issueOwn({ name: "member-key" });

    const list = await adminCaller.apiKeys.listOrg({ orgId: org.id });
    expect(list.map((r) => r.name).sort()).toEqual(["admin-key", "member-key"]);
    // Scrub assertions: org admins must never see raw key material or
    // any secret-derived / PII fields in the list response.
    expect(list[0]).not.toHaveProperty("keyHash");
    expect(list[0]).not.toHaveProperty("revealTokenHash");
    expect(list[0]).not.toHaveProperty("revealedByIp");
    // Reveal-status fields ARE expected — they let the admin UI distinguish
    // "admin-issued, pending reveal" from "claimed". Neither is secret-derived.
    expect(list[0]).toHaveProperty("revealedAt");
    expect(list[0]).toHaveProperty("revealTokenExpiresAt");

    await expect(
      memberCaller.apiKeys.listOrg({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listOrg: optional userId narrows to a single member's keys", async () => {
    // The admin-per-user UI passes `userId` so the browser doesn't receive
    // metadata for unrelated org members. Behaviour: same RBAC (list_all),
    // but results are WHERE-narrowed to the target user.
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const memberA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const memberB = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const callerA = await callerFor({ db: t.db, userId: memberA.id, redis });
    const callerB = await callerFor({ db: t.db, userId: memberB.id, redis });

    await callerA.apiKeys.issueOwn({ name: "a-key-1" });
    await callerA.apiKeys.issueOwn({ name: "a-key-2" });
    await callerB.apiKeys.issueOwn({ name: "b-key" });

    // Without filter: all three keys.
    const all = await adminCaller.apiKeys.listOrg({ orgId: org.id });
    expect(all.map((r) => r.name).sort()).toEqual([
      "a-key-1",
      "a-key-2",
      "b-key",
    ]);

    // With userId filter: only memberA's keys.
    const onlyA = await adminCaller.apiKeys.listOrg({
      orgId: org.id,
      userId: memberA.id,
    });
    expect(onlyA.map((r) => r.name).sort()).toEqual(["a-key-1", "a-key-2"]);
    expect(onlyA.every((r) => r.userId === memberA.id)).toBe(true);

    // Non-member userId: empty result, not a permission error (filter is just
    // a WHERE narrowing; org_admin still authorises).
    const stranger = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const empty = await adminCaller.apiKeys.listOrg({
      orgId: org.id,
      userId: stranger.id,
    });
    expect(empty).toEqual([]);
  });

  it("revoke: sets revokedAt; subsequent listOwn excludes; double-revoke → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    const issued = await caller.apiKeys.issueOwn({ name: "to-revoke" });

    const result = await caller.apiKeys.revoke({ id: issued.id });
    expect(result.ok).toBe(true);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.revokedAt).not.toBeNull();

    const list = await caller.apiKeys.listOwn();
    expect(list.some((r) => r.id === issued.id)).toBe(false);

    await expect(
      caller.apiKeys.revoke({ id: issued.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // #191 — binding a key to an account group (so it routes to that group's
  // platform/accounts instead of the legacy null-group anthropic default).
  async function makeGroup(orgId: string, platform = "openai") {
    const [g] = await t.db
      .insert(accountGroups)
      .values({ orgId, name: `grp-${Math.random().toString(36).slice(2, 8)}`, platform })
      .returning({ id: accountGroups.id });
    return g!.id;
  }

  it("issueOwn: binds groupId when the group is in the caller's org", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const groupId = await makeGroup(org.id);
    const caller = await callerFor({ db: t.db, userId: user.id, redis });

    const result = await caller.apiKeys.issueOwn({ name: "oai-key", groupId });
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row!.groupId).toBe(groupId);
  });

  it("issueOwn: omitting groupId leaves it null (legacy/anthropic default)", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    const result = await caller.apiKeys.issueOwn({ name: "legacy-key" });
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row!.groupId).toBeNull();
  });

  it("issueOwn: groupId from another org → FORBIDDEN (cross-tenant group guard)", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const userA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const groupInB = await makeGroup(orgB.id);
    const caller = await callerFor({ db: t.db, userId: userA.id, redis });
    await expect(
      caller.apiKeys.issueOwn({ name: "x", groupId: groupInB }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("group"),
    });
  });

  it("issueForUser: binds groupId for the target user", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const groupId = await makeGroup(org.id);
    const caller = await callerFor({ db: t.db, userId: admin.id, redis });

    const result = await caller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "admin-oai",
      groupId,
    });
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row!.groupId).toBe(groupId);
  });

  it("issueForUser: groupId from another org → FORBIDDEN (cross-tenant group guard)", async () => {
    // org_admin in orgA targets a member of orgA (membership passes) but
    // supplies a groupId that lives in orgB. The group-org check must reject
    // so the inserted row can't cross-bind org and account group.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const groupInB = await makeGroup(orgB.id);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const targetA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminA.id, redis });

    await expect(
      caller.apiKeys.issueForUser({
        orgId: orgA.id,
        targetUserId: targetA.id,
        name: "x",
        groupId: groupInB,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  // ── PR5: setEvaluateAsProject (per-key "score as project" opt-in) ────────────

  it("setEvaluateAsProject: owner toggles their own key on, then off; column persists; audit written", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    const issued = await caller.apiKeys.issueOwn({ name: "to-opt-in" });

    // Default is false.
    const [before] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(before!.evaluateAsProject).toBe(false);

    const onRes = await caller.apiKeys.setEvaluateAsProject({
      id: issued.id,
      enabled: true,
    });
    expect(onRes.ok).toBe(true);

    const [afterOn] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(afterOn!.evaluateAsProject).toBe(true);

    // Audit row written.
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "api_key.evaluate_as_project_set"));
    expect(audits.some((a) => a.targetId === issued.id)).toBe(true);

    // Toggling off works too.
    await caller.apiKeys.setEvaluateAsProject({ id: issued.id, enabled: false });
    const [afterOff] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(afterOff!.evaluateAsProject).toBe(false);
  });

  it("setEvaluateAsProject: org_admin can toggle another member's key", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const memberCaller = await callerFor({ db: t.db, userId: member.id, redis });
    const issued = await memberCaller.apiKeys.issueOwn({ name: "member-key" });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id, redis });
    const res = await adminCaller.apiKeys.setEvaluateAsProject({
      id: issued.id,
      enabled: true,
    });
    expect(res.ok).toBe(true);
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.evaluateAsProject).toBe(true);
  });

  it("setEvaluateAsProject: non-owner non-admin → FORBIDDEN (key untouched)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const other = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const ownerCaller = await callerFor({ db: t.db, userId: owner.id, redis });
    const issued = await ownerCaller.apiKeys.issueOwn({ name: "owners-key" });

    const otherCaller = await callerFor({ db: t.db, userId: other.id, redis });
    await expect(
      otherCaller.apiKeys.setEvaluateAsProject({
        id: issued.id,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.evaluateAsProject).toBe(false);
  });

  it("setEvaluateAsProject: unknown key id → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    await expect(
      caller.apiKeys.setEvaluateAsProject({
        id: "00000000-0000-0000-0000-000000000000",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listOwn / listOrg surface evaluateAsProject toggle state", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const memberCaller = await callerFor({ db: t.db, userId: member.id, redis });
    const issued = await memberCaller.apiKeys.issueOwn({ name: "surfaced-key" });
    await memberCaller.apiKeys.setEvaluateAsProject({
      id: issued.id,
      enabled: true,
    });

    const own = await memberCaller.apiKeys.listOwn();
    const ownRow = own.find((r) => r.id === issued.id)!;
    expect(ownRow).toHaveProperty("evaluateAsProject");
    expect(ownRow.evaluateAsProject).toBe(true);

    const adminCaller = await callerFor({ db: t.db, userId: admin.id, redis });
    const org_ = await adminCaller.apiKeys.listOrg({ orgId: org.id });
    const orgRow = org_.find((r) => r.id === issued.id)!;
    expect(orgRow.evaluateAsProject).toBe(true);
  });
});
