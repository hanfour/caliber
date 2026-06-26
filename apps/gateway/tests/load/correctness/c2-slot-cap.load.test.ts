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
  // THE no-over-allocation invariant: exactly K requests hold a slot (each held
  // 800ms), the rest shed. ok===K is what proves the cap engaged — never >K
  // concurrent. Robust under concurrency (the K winners acquire before any loser
  // mutates account state).
  expect(ok).toBe(K);
  expect(shed.length).toBe(N - K);

  // A slot-capped shed terminates as one of THREE timing-dependent but
  // semantically-equivalent "no capacity, retry shortly" 503s — confirmed by
  // capturing the live shapes on CI:
  //   - all_upstreams_failed   : the loser attempted, slot acquire failed
  //     (CapacityError→synthetic 500→switch_account), then re-select excluded
  //     the now-failed single account → AllUpstreamsFailed(attempted=[acct]).
  //   - no_upstream_available  : a concurrent loser had already marked the
  //     account transiently unschedulable, so this loser's scheduler.select
  //     found zero candidates BEFORE attempting → AllUpstreamsFailed(attempted=[]).
  //   - account_at_capacity    : the per-attempt CapacityError surfaced directly
  //     (the shape C1 documents for the same slot-cap mechanism).
  // Asserting one exact string is what made this gate flaky (~40-50% on CI).
  const CAPACITY_SHED = [
    "all_upstreams_failed",
    "no_upstream_available",
    "account_at_capacity",
  ];
  for (const r of shed) expect(CAPACITY_SHED).toContain(r.json?.error);

  // Slot-layer sanity: over_limit rejections never EXCEED the sheddable count
  // (each loser hits acquireSlot at most once — 500→switch_account, no
  // retry_same). Not an equality: a loser that sheds as no_upstream_available is
  // excluded at selection and never reaches the slot layer, so the exact count
  // is timing-dependent. The real guarantee is ok===K above.
  const after = await counterValue(stack.app.gwMetrics.slotAcquireTotal, { scope: "account", result: "over_limit" });
  expect(after - before).toBeLessThanOrEqual(N - K);
});
