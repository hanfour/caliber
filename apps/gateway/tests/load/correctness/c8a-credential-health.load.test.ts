import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upstreamAccounts } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { counterValue } from "../scrapeMetrics.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const N = 3;
beforeAll(async () => { stack = await bootStack({ authMaxFail: N }); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C8a: N consecutive 401s degrade ONLY that api_key account recoverably (status stays active); metric +1", async () => {
  const orgId = await seedOrg(stack.db, "c8a");
  const userId = await seedUser(stack.db, "c8a", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c8a", 1, "pool");
  const dead = await seedAccount(stack.db, orgId, "c8a", 1, { userId: null });
  const healthy = await seedAccount(stack.db, orgId, "c8a", 2, { userId: null });
  stack.fake.forceStatus(dead.credToken, 401);

  const before = await counterValue(stack.app.gwMetrics.upstreamCredentialDegradedTotal, { platform: "anthropic" });
  for (let i = 0; i < N; i++) await postMessages(stack.baseUrl, m.rawKey);

  const deadRow = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, dead.id)))[0]!;
  expect(deadRow.tempUnschedulableReason).toBe("api_key_invalid_credential");
  expect(deadRow.status).toBe("active");
  expect(deadRow.tempUnschedulableUntil).not.toBeNull();

  const healthyRow = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, healthy.id)))[0]!;
  expect(healthyRow.tempUnschedulableReason).toBeNull();

  const after = await counterValue(stack.app.gwMetrics.upstreamCredentialDegradedTotal, { platform: "anthropic" });
  expect(after - before).toBe(1);
});

it("C8a: a 403 neither degrades nor resets the counter", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c8a2");
  const userId = await seedUser(stack.db, "c8a2", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c8a2", 1, "pool");
  const acct = await seedAccount(stack.db, orgId, "c8a2", 1, { userId: null });
  const healthy = await seedAccount(stack.db, orgId, "c8a2", 2, { userId: null });
  stack.fake.forceStatus(acct.credToken, 403);

  for (let i = 0; i < N + 2; i++) await postMessages(stack.baseUrl, m.rawKey);

  const row = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, acct.id)))[0]!;
  expect(row.tempUnschedulableReason).not.toBe("api_key_invalid_credential");
});
