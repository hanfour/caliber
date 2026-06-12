import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { counterValue } from "../scrapeMetrics.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const K = 3, N = 6; // N <= maxWait (50) so the bottleneck is the slot, not the queue
beforeAll(async () => { stack = await bootStack({ maxWait: 50 }); }, 120_000);
afterAll(async () => { await stack.teardown(); });

it("C2: single account concurrency=K — K proceed, N-K shed at the slot layer (no over-allocation)", async () => {
  const orgId = await seedOrg(stack.db, "c2");
  const userId = await seedUser(stack.db, "c2", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c2", 1, "pool");
  // ONE pool account, concurrency=K. Fake holds each slot for 800ms so K fill up.
  await seedAccount(stack.db, orgId, "c2", 1, { userId: null, concurrency: K });
  stack.fake.setLatency(800);

  const before = await counterValue(stack.app.gwMetrics.slotAcquireTotal, { scope: "account", result: "over_limit" });

  const results = await Promise.all(Array.from({ length: N }, () => postMessages(stack.baseUrl, m.rawKey)));

  const ok = results.filter((r) => r.status === 200).length;
  const shed = results.filter((r) => r.status === 503);
  expect(ok).toBe(K);
  expect(shed.length).toBe(N - K);
  // Single account exhausts the failover loop → all_upstreams_failed (NOT account_at_capacity).
  expect(shed.every((r) => r.json?.error === "all_upstreams_failed")).toBe(true);

  // The real no-over-allocation invariant: over_limit rejections == N-K.
  const after = await counterValue(stack.app.gwMetrics.slotAcquireTotal, { scope: "account", result: "over_limit" });
  expect(after - before).toBe(N - K);
});
