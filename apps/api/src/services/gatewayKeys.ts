import { apiKeys, type Database } from "@caliber/db";
import { generateApiKey, hashApiKey } from "@caliber/gateway-core";
import { and, eq } from "drizzle-orm";

/**
 * Issue an `own_then_pool` gateway key for a user, idempotently by name.
 *
 * Used by `caliber login --gateway` (#256): the device-auth approval mints a
 * key so the CLI can auto-configure Claude Code without a separate dashboard
 * trip. `own_then_pool` (never the `pool` default, which 503s for BYOK-only
 * orgs) routes to the user's own upstream first, falling back to a shared
 * pool.
 *
 * Idempotency: if an active key with the same name already exists for this
 * user we return `{ created: false }` WITHOUT a raw key (the plaintext is
 * unrecoverable — only the hash is stored), so callers must treat a re-run as
 * "already provisioned, reuse your stored key".
 */
export async function issueOwnGatewayKey(
  db: Database,
  input: { userId: string; orgId: string; name: string; pepper: string },
): Promise<{ created: true; rawKey: string } | { created: false }> {
  const existing = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, input.userId),
        eq(apiKeys.name, input.name),
        eq(apiKeys.status, "active"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { created: false };

  const { raw, prefix } = generateApiKey();
  const keyHash = hashApiKey(input.pepper, raw);
  await db.insert(apiKeys).values({
    userId: input.userId,
    orgId: input.orgId,
    teamId: null,
    groupId: null,
    keyHash,
    keyPrefix: prefix,
    name: input.name,
    status: "active",
    issuedByUserId: null,
    routingPolicy: "own_then_pool",
  });
  return { created: true, rawKey: raw };
}
