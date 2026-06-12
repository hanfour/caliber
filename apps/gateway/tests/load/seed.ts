import {
  organizations,
  users,
  organizationMembers,
  apiKeys,
  upstreamAccounts,
  credentialVault,
} from "@caliber/db/schema";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import type { Database } from "@caliber/db";

// Suite-wide 64-char-hex secrets (env-schema requires hex shape).
export const masterKey = "a".repeat(64);
export const pepper = "b".repeat(64);

export type RoutingPolicy = "pool" | "own" | "own_then_pool";
export type Platform = "anthropic" | "openai";

export interface SeededMember {
  userId: string;
  apiKeyId: string;
  rawKey: string;
  routingPolicy: RoutingPolicy;
}

/** Create an org; the slug carries the scenario slug so rows are traceable. */
export async function seedOrg(db: Database, slug: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `${slug}-org`, name: slug })
    .returning();
  return org!.id;
}

export async function seedUser(
  db: Database,
  slug: string,
  n: number,
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${slug}-u${n}@e.com` })
    .returning();
  return u!.id;
}

export async function seedMembership(
  db: Database,
  orgId: string,
  userId: string,
): Promise<void> {
  // `organization_members` is the membership table (orgId/userId composite PK,
  // joinedAt defaulted) — there is no `role` column on it.
  await db.insert(organizationMembers).values({ orgId, userId });
}

/**
 * Issue an api key for a user with the given routing policy. Returns the raw
 * key (for the Authorization header) + its row id (for usage_logs joins).
 */
export async function seedApiKey(
  db: Database,
  orgId: string,
  userId: string,
  slug: string,
  n: number,
  routingPolicy: RoutingPolicy,
): Promise<SeededMember> {
  const rawKey = `ak_${slug}_${n}_${"0".repeat(20)}`.slice(0, 28);
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId,
      userId,
      keyHash: hashApiKey(pepper, rawKey),
      keyPrefix: rawKey.slice(0, 8),
      name: `${slug}-k${n}`,
      routingPolicy,
    })
    .returning({ id: apiKeys.id });
  return { userId, apiKeyId: row!.id, rawKey, routingPolicy };
}

export interface SeedAccountOpts {
  userId?: string | null; // null/undefined → pool; set → BYOK own
  platform?: Platform; // default "anthropic"
  concurrency?: number; // per-account slot cap
  priority?: number;
  schedulable?: boolean; // default true
  status?: "active" | "error";
  credToken?: string; // the x-api-key the fake will receive (default unique)
}

/** Seed an upstream_accounts row + its encrypted api_key credential. Returns {id, credToken}. */
export async function seedAccount(
  db: Database,
  orgId: string,
  slug: string,
  n: number,
  opts: SeedAccountOpts = {},
): Promise<{ id: string; credToken: string }> {
  const platform = opts.platform ?? "anthropic";
  const credToken = opts.credToken ?? `tok-${slug}-${n}`;
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      userId: opts.userId ?? null,
      name: `${slug}-acct${n}`,
      platform,
      type: "api_key",
      schedulable: opts.schedulable ?? true,
      status: opts.status ?? "active",
      ...(opts.concurrency !== undefined
        ? { concurrency: opts.concurrency }
        : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    })
    .returning();
  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: credToken }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });
  return { id: acct!.id, credToken };
}
