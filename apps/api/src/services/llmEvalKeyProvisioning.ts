import { randomBytes } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { users, apiKeys, organizations, organizationMembers } from "@caliber/db";
import { hashApiKey } from "@caliber/gateway-core";
import type { Redis } from "ioredis";

export interface ProvisionLlmEvalKeyInput {
  db: Database;
  redis: Redis;
  orgId: string;
  apiKeyHashPepper: string;
}

export interface ProvisionLlmEvalKeyResult {
  keyId: string;
  systemUserId: string;
  redisSecretKey: string;
  created: boolean;
}

function redisKeyFor(orgId: string): string {
  return `llm-eval-key:${orgId}`;
}

function rawRedisKeyFor(orgId: string): string {
  return `aide:gw:llm-eval-key:${orgId}`;
}

async function findValidApiKeyRow(
  db: Database,
  keyId: string,
): Promise<{ id: string; revokedAt: Date | null } | null> {
  const [row] = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId));
  return row ?? null;
}

export async function provisionLlmEvalKey(
  input: ProvisionLlmEvalKeyInput,
): Promise<ProvisionLlmEvalKeyResult> {
  const { db, redis, orgId, apiKeyHashPepper } = input;

  // 1. Look up the org to get the slug.
  const [org] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  if (!org) {
    throw new Error(`Organization not found: ${orgId}`);
  }

  const orgSlug = org.slug;
  const redisKey = redisKeyFor(orgId);
  const fullRedisKey = rawRedisKeyFor(orgId);

  // 2. Check Redis for an existing raw key.
  const existingRaw = await redis.get(redisKey);

  if (existingRaw !== null) {
    // Verify the corresponding api_keys row is still valid (not revoked).
    const systemUserEmail = `evaluator@${orgSlug}.internal`;
    const [systemUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, systemUserEmail));

    if (systemUser) {
      const [existingKey] = await db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.userId, systemUser.id),
            eq(apiKeys.orgId, orgId),
            isNull(apiKeys.revokedAt),
          ),
        );

      if (existingKey) {
        // Key is still valid — return early without creating a new one.
        return {
          keyId: existingKey.id,
          systemUserId: systemUser.id,
          redisSecretKey: fullRedisKey,
          created: false,
        };
      }
    }
    // Key in Redis is stale (row gone or revoked) — fall through to re-provision.
  }

  // 3. Find or create the system user.
  const systemUserEmail = `evaluator@${orgSlug}.internal`;
  let systemUserId: string;

  const [existingSystemUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, systemUserEmail));

  if (existingSystemUser) {
    systemUserId = existingSystemUser.id;
  } else {
    const [newUser] = await db
      .insert(users)
      .values({
        email: systemUserEmail,
        name: `Evaluator (system) — ${orgSlug}`,
        emailVerified: new Date(),
        image: null,
      })
      .returning({ id: users.id });

    if (!newUser) {
      throw new Error("Failed to create system user");
    }
    systemUserId = newUser.id;
  }

  // 4. Ensure the system user is NOT a member of the org.
  const [memberRow] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, systemUserId),
      ),
    );

  if (memberRow) {
    throw new Error(
      `System user ${systemUserEmail} must not be an org member — found in organization_members`,
    );
  }

  // 5. Revoke any previous active key for this system user + org.
  const previousKeys = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, systemUserId),
        eq(apiKeys.orgId, orgId),
        isNull(apiKeys.revokedAt),
      ),
    );

  if (previousKeys.length > 0) {
    for (const prevKey of previousKeys) {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, prevKey.id));
    }
  }

  // 6. Generate a new api key.
  const rawSuffix = randomBytes(32).toString("hex");
  const rawKey = `aide-eval-${rawSuffix}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = hashApiKey(apiKeyHashPepper, rawKey);

  const [newKey] = await db
    .insert(apiKeys)
    .values({
      userId: systemUserId,
      orgId,
      teamId: null,
      keyHash,
      keyPrefix,
      name: `LLM Evaluator (system) — ${orgSlug}`,
      status: "active",
      quotaUsd: "0",
      quotaUsedUsd: "0",
      rateLimit1dUsd: "0",
      issuedByUserId: null,
    })
    .returning({ id: apiKeys.id });

  if (!newKey) {
    throw new Error("Failed to insert api_keys row");
  }

  // 7. Store raw key in Redis (no TTL — persists until rotated).
  await redis.set(redisKey, rawKey);

  return {
    keyId: newKey.id,
    systemUserId,
    redisSecretKey: fullRedisKey,
    created: true,
  };
}
