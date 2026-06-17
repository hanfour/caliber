import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue, usageLogCount } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C0: a single 200 flows end-to-end and writes exactly one usage_logs row; baseline clean", async () => {
  expect(await usageLogCount(stack.db)).toBe(0); // resetState gave a clean slate

  const orgId = await seedOrg(stack.db, "c0");
  const userId = await seedUser(stack.db, "c0", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c0", 1, "pool");
  await seedAccount(stack.db, orgId, "c0", 1, { userId: null }); // pool account

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(200);

  await drainUsageQueue(stack.db, 1);
  expect(await usageLogCount(stack.db)).toBe(1);
});
