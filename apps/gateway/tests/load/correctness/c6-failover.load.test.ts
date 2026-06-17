import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const S = 5;
beforeAll(async () => { stack = await bootStack({ maxSwitches: S }); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C6: S-1 accounts forced 503 + 1 healthy → request lands on the healthy one (within switch budget)", async () => {
  const orgId = await seedOrg(stack.db, "c6a");
  const userId = await seedUser(stack.db, "c6a", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c6a", 1, "pool");
  for (let i = 0; i < S - 1; i++) {
    const bad = await seedAccount(stack.db, orgId, "c6a", i, { userId: null, priority: 1 }); // higher prio first
    stack.fake.forceStatus(bad.credToken, 503);
  }
  const healthy = await seedAccount(stack.db, orgId, "c6a", 99, { userId: null, priority: 100 });

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(200);
  await drainUsageQueue(stack.db, 1);
  const rows = await stack.db.select({ a: usageLogs.accountId }).from(usageLogs);
  expect(rows[0]!.a).toBe(healthy.id);
  const cnt = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  expect(cnt[0]!.c).toBe(1);
});

it("C6: every account 503 → 503 all_upstreams_failed", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c6b");
  const userId = await seedUser(stack.db, "c6b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c6b", 1, "pool");
  for (let i = 0; i < 3; i++) {
    const bad = await seedAccount(stack.db, orgId, "c6b", i, { userId: null });
    stack.fake.forceStatus(bad.credToken, 503);
  }
  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(503);
  expect(r.json?.error).toBe("all_upstreams_failed");
});
