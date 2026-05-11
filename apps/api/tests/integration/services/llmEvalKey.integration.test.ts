import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { users, apiKeys, organizationMembers } from "@caliber/db";
import { verifyApiKey } from "@caliber/gateway-core";
import { setupTestDb, makeOrg, defaultTestEnv } from "../../factories/index.js";
import { provisionLlmEvalKey } from "../../../src/services/llmEvalKeyProvisioning.js";

const TEST_PEPPER = defaultTestEnv.API_KEY_HASH_PEPPER!;

let t: Awaited<ReturnType<typeof setupTestDb>>;
let redis: Redis;

beforeAll(async () => {
  t = await setupTestDb();
});

afterAll(async () => {
  await t.stop();
});

beforeEach(() => {
  // Fresh in-memory store per test to prevent key leakage between cases.
  // keyPrefix mirrors the gateway namespace so Redis key format assertions
  // can verify the full canonical path.
  redis = new RedisMock({ keyPrefix: "aide:gw:" }) as unknown as Redis;
});

describe("provisionLlmEvalKey", () => {
  it("first provisioning: creates system user + api_key + stores in Redis, returns created=true", async () => {
    const org = await makeOrg(t.db);

    const result = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    expect(result.created).toBe(true);
    expect(result.keyId).toBeTruthy();
    expect(result.systemUserId).toBeTruthy();
    expect(result.redisSecretKey).toBe(`aide:gw:llm-eval-key:${org.id}`);

    // Verify the system user was created with the correct email.
    const [sysUser] = await t.db
      .select()
      .from(users)
      .where(eq(users.id, result.systemUserId));
    expect(sysUser).toBeDefined();
    expect(sysUser!.email).toBe(`evaluator@${org.slug}.internal`);
    expect(sysUser!.emailVerified).not.toBeNull();

    // Verify the api_keys row was inserted correctly.
    const [keyRow] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.keyId));
    expect(keyRow).toBeDefined();
    expect(keyRow!.orgId).toBe(org.id);
    expect(keyRow!.userId).toBe(result.systemUserId);
    expect(keyRow!.status).toBe("active");
    expect(keyRow!.revokedAt).toBeNull();
    expect(keyRow!.issuedByUserId).toBeNull();
    // Decimal columns are returned with full precision by postgres driver.
    expect(parseFloat(keyRow!.quotaUsd)).toBe(0);
    expect(parseFloat(keyRow!.rateLimit1dUsd)).toBe(0);

    // Verify the raw key was stored in Redis and can roundtrip via verifyApiKey.
    const storedRaw = await redis.get(`llm-eval-key:${org.id}`);
    expect(storedRaw).not.toBeNull();
    expect(storedRaw!.startsWith("aide-eval-")).toBe(true);
    expect(verifyApiKey(TEST_PEPPER, storedRaw!, keyRow!.keyHash)).toBe(true);
  });

  it("re-call is idempotent: returns same keyId and created=false; Redis value unchanged", async () => {
    const org = await makeOrg(t.db);

    const first = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });
    expect(first.created).toBe(true);

    const rawAfterFirst = await redis.get(`llm-eval-key:${org.id}`);

    const second = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    expect(second.created).toBe(false);
    expect(second.keyId).toBe(first.keyId);
    expect(second.systemUserId).toBe(first.systemUserId);

    // The raw key stored in Redis must not have changed.
    const rawAfterSecond = await redis.get(`llm-eval-key:${org.id}`);
    expect(rawAfterSecond).toBe(rawAfterFirst);
  });

  it("system user is NOT an org member: evaluator user not in organizationMembers", async () => {
    const org = await makeOrg(t.db);

    const result = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    // The system user must not appear in organization_members for this org.
    const memberRows = await t.db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, org.id),
          eq(organizationMembers.userId, result.systemUserId),
        ),
      );

    expect(memberRows).toHaveLength(0);
  });

  it("Redis secret key format: key is aide:gw:llm-eval-key:{orgId} with raw key as value", async () => {
    const org = await makeOrg(t.db);

    const result = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    // The canonical full Redis key reported in the result.
    expect(result.redisSecretKey).toBe(`aide:gw:llm-eval-key:${org.id}`);

    // With keyPrefix="aide:gw:", the mock exposes the value via the suffix.
    const value = await redis.get(`llm-eval-key:${org.id}`);
    expect(value).not.toBeNull();
    // Raw key must use the distinguishing prefix.
    expect(value!.startsWith("aide-eval-")).toBe(true);
    // The raw key suffix should be 64 hex chars (32 random bytes).
    expect(value).toMatch(/^aide-eval-[0-9a-f]{64}$/);
  });

  it("revoked api_key triggers re-provisioning: creates new key and revokes old", async () => {
    const org = await makeOrg(t.db);

    // Provision once.
    const first = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });
    expect(first.created).toBe(true);

    // Revoke the existing key directly to simulate expiry/manual revocation.
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, first.keyId));

    // Clear the Redis entry to simulate stale/missing cache.
    await redis.del(`llm-eval-key:${org.id}`);

    // Provision again — should create a fresh key.
    const second = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    expect(second.created).toBe(true);
    expect(second.keyId).not.toBe(first.keyId);
    expect(second.systemUserId).toBe(first.systemUserId);

    // Old key must remain revoked.
    const [oldKeyRow] = await t.db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, first.keyId));
    expect(oldKeyRow!.revokedAt).not.toBeNull();

    // New key is active.
    const [newKeyRow] = await t.db
      .select({ revokedAt: apiKeys.revokedAt, status: apiKeys.status })
      .from(apiKeys)
      .where(eq(apiKeys.id, second.keyId));
    expect(newKeyRow!.revokedAt).toBeNull();
    expect(newKeyRow!.status).toBe("active");

    // Redis has the new raw key.
    const newRaw = await redis.get(`llm-eval-key:${org.id}`);
    expect(newRaw).not.toBeNull();
    expect(newRaw!.startsWith("aide-eval-")).toBe(true);
    expect(verifyApiKey(TEST_PEPPER, newRaw!, newKeyRow!.status)).toBe(false); // just status not keyHash
    // Roundtrip check against keyHash.
    const [newKey] = await t.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.id, second.keyId));
    expect(verifyApiKey(TEST_PEPPER, newRaw!, newKey!.keyHash)).toBe(true);
  });

  it("re-provisioning when Redis still has stale key: detects revoked DB row and re-provisions", async () => {
    const org = await makeOrg(t.db);

    // Provision once.
    const first = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });
    expect(first.created).toBe(true);

    // Revoke the DB row but keep the Redis entry stale.
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, first.keyId));

    // Provision again — Redis key exists but DB row is revoked, so re-provisions.
    const second = await provisionLlmEvalKey({
      db: t.db,
      redis,
      orgId: org.id,
      apiKeyHashPepper: TEST_PEPPER,
    });

    expect(second.created).toBe(true);
    expect(second.keyId).not.toBe(first.keyId);

    // New raw key is stored in Redis.
    const newRaw = await redis.get(`llm-eval-key:${org.id}`);
    const [newKey] = await t.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.id, second.keyId));
    expect(verifyApiKey(TEST_PEPPER, newRaw!, newKey!.keyHash)).toBe(true);
  });

  it("missing org: non-existent orgId throws with clear error", async () => {
    const nonExistentOrgId = "00000000-0000-0000-0000-000000000000";

    await expect(
      provisionLlmEvalKey({
        db: t.db,
        redis,
        orgId: nonExistentOrgId,
        apiKeyHashPepper: TEST_PEPPER,
      }),
    ).rejects.toThrow(`Organization not found: ${nonExistentOrgId}`);
  });
});
