import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { usageLogs, upstreamAccounts } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C1: concurrent multi-member own traffic — zero cross-user attribution leak", async () => {
  const orgId = await seedOrg(stack.db, "c1");
  const K = 4, REQ_PER = 5;
  const members = [];
  for (let i = 0; i < K; i++) {
    const userId = await seedUser(stack.db, "c1", i);
    await seedMembership(stack.db, orgId, userId);
    const m = await seedApiKey(stack.db, orgId, userId, "c1", i, "own");
    // Each member's OWN upstream. concurrency = REQ_PER so the per-member burst
    // fits: a bare `own`-policy key has no failover target, and the gateway
    // sheds an at-capacity slot as 503 `account_at_capacity` (NOT a blocking
    // wait — withSlotAndCredential.ts). Sizing the slot to the burst keeps the
    // attribution invariant under genuine concurrency without weakening it.
    await seedAccount(stack.db, orgId, "c1", i, { userId, concurrency: REQ_PER });
    members.push(m);
  }

  const calls = members.flatMap((m) =>
    Array.from({ length: REQ_PER }, () => postMessages(stack.baseUrl, m.rawKey)),
  );
  const results = await Promise.all(calls);
  expect(results.every((r) => r.status === 200)).toBe(true);

  await drainUsageQueue(stack.db, K * REQ_PER);

  const leaks = await stack.db
    .select({ c: sql<number>`count(*)::int` })
    .from(usageLogs)
    .innerJoin(upstreamAccounts, eq(usageLogs.accountId, upstreamAccounts.id))
    .where(and(isNotNull(upstreamAccounts.userId), ne(upstreamAccounts.userId, usageLogs.userId)));
  expect(leaks[0]!.c).toBe(0);

  for (const m of members) {
    const rows = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs).where(eq(usageLogs.apiKeyId, m.apiKeyId));
    expect(rows[0]!.c).toBe(REQ_PER);
  }
});

it("C1b: own-policy key with no own upstream → 409 no_own_upstream, never the org pool", async () => {
  const orgId = await seedOrg(stack.db, "c1b");
  const userId = await seedUser(stack.db, "c1b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c1b", 1, "own"); // own policy
  await seedAccount(stack.db, orgId, "c1b", 9, { userId: null });        // ONLY a pool account exists

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(409);
  expect(r.json).toMatchObject({ error: "no_own_upstream" });
});
