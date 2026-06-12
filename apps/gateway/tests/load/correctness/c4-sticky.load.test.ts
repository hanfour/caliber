import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountGroups, accountGroupMembers, apiKeys, upstreamAccounts } from "@caliber/db/schema";
import type { Database } from "@caliber/db";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount, type Platform } from "../seed.js";
import { postResponsesAndAccount, postMessagesAndAccount } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

/**
 * Create an account_group on `platform`, add the given accounts as members, and
 * bind the api key to it (`api_keys.group_id`). Sticky (scheduler Layers 1/2)
 * only engages when the request carries a REAL (non-legacy) groupId AND Redis is
 * present; the binding here is what flips the key out of the legacy/Layer-3 path.
 * Pool policy is mandatory — `api_keys_routing_policy_group_mutex` CHECK forbids
 * a non-pool key from carrying a group_id.
 */
async function bindGroup(
  db: Database, orgId: string, slug: string, platform: Platform, apiKeyId: string, accountIds: string[],
): Promise<string> {
  const [g] = await db
    .insert(accountGroups)
    .values({ orgId, name: `${slug}-grp`, platform })
    .returning({ id: accountGroups.id });
  const groupId = g!.id;
  await db
    .insert(accountGroupMembers)
    .values(accountIds.map((accountId) => ({ groupId, accountId })));
  await db.update(apiKeys).set({ groupId }).where(eq(apiKeys.id, apiKeyId));
  return groupId;
}

it("C4-L1: OpenAI Responses previous_response_id sticks, then rebinds when the target is unschedulable", async () => {
  const orgId = await seedOrg(stack.db, "c4l1");
  const userId = await seedUser(stack.db, "c4l1", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c4l1", 1, "pool");

  // Two openai-platform pool accounts in one group → sticky candidates.
  const a1 = await seedAccount(stack.db, orgId, "c4l1", 1, { userId: null, platform: "openai" });
  const a2 = await seedAccount(stack.db, orgId, "c4l1", 2, { userId: null, platform: "openai" });
  await bindGroup(stack.db, orgId, "c4l1", "openai", m.apiKeyId, [a1.id, a2.id]);

  const PRID = "resp_sticky_c4l1";
  let total = 0;

  // First request binds the sticky key to whichever account load-balance picked.
  const first = await postResponsesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, PRID);
  expect(first.status).toBe(200);
  const stuckTo = first.accountId;
  expect(stuckTo === a1.id || stuckTo === a2.id).toBe(true);

  // Same previous_response_id → Layer 1 sticky hit on the SAME account, 6×
  // (6 consecutive same-account hits over 2 equal-weight candidates makes a
  // no-sticky coincidence ~1/64, not ~1/8).
  for (let i = 0; i < 6; i++) {
    const r = await postResponsesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, PRID);
    expect(r.status).toBe(200);
    expect(r.accountId).toBe(stuckTo);
  }

  // Make the stuck account unschedulable → next sticky read self-heals (the
  // cached id no longer loads), falls to Layer 3, and rebinds to the OTHER one.
  await stack.db
    .update(upstreamAccounts)
    .set({ schedulable: false })
    .where(eq(upstreamAccounts.id, stuckTo!));

  const rebind = await postResponsesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, PRID);
  expect(rebind.status).toBe(200);
  expect(rebind.accountId).not.toBe(stuckTo);
  expect(rebind.accountId === a1.id || rebind.accountId === a2.id).toBe(true);
});

it("C4-L2: Anthropic Messages X-Claude-Session-Id sticks, then rebinds when the target is unschedulable", async () => {
  const orgId = await seedOrg(stack.db, "c4l2");
  const userId = await seedUser(stack.db, "c4l2", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c4l2", 1, "pool");

  // Two anthropic-platform pool accounts in one group → sticky candidates.
  const a1 = await seedAccount(stack.db, orgId, "c4l2", 1, { userId: null, platform: "anthropic" });
  const a2 = await seedAccount(stack.db, orgId, "c4l2", 2, { userId: null, platform: "anthropic" });
  await bindGroup(stack.db, orgId, "c4l2", "anthropic", m.apiKeyId, [a1.id, a2.id]);

  const SESSION = "sess-c4l2";
  let total = 0;

  const first = await postMessagesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, SESSION);
  expect(first.status).toBe(200);
  const stuckTo = first.accountId;
  expect(stuckTo === a1.id || stuckTo === a2.id).toBe(true);

  // 6× consecutive same-session hits → no-sticky coincidence ~1/64.
  for (let i = 0; i < 6; i++) {
    const r = await postMessagesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, SESSION);
    expect(r.status).toBe(200);
    expect(r.accountId).toBe(stuckTo);
  }

  await stack.db
    .update(upstreamAccounts)
    .set({ schedulable: false })
    .where(eq(upstreamAccounts.id, stuckTo!));

  const rebind = await postMessagesAndAccount(stack.baseUrl, stack.db, m.rawKey, ++total, SESSION);
  expect(rebind.status).toBe(200);
  expect(rebind.accountId).not.toBe(stuckTo);
  expect(rebind.accountId === a1.id || rebind.accountId === a2.id).toBe(true);
});
