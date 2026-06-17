import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

async function setup(slug: string) {
  const orgId = await seedOrg(stack.db, slug);
  const userId = await seedUser(stack.db, slug, 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, slug, 1, "pool");
  await seedAccount(stack.db, orgId, slug, 1, { userId: null });
  return m;
}

it("C5: concurrent same X-Request-Id → exactly one reaches upstream, the rest 409 request_in_progress", async () => {
  const m = await setup("c5a");
  stack.fake.setLatency(400); // widen the in-flight window so duplicates collide
  const id = "req-c5-concurrent";
  const results = await Promise.all(Array.from({ length: 5 }, () => postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id })));
  const ok = results.filter((r) => r.status === 200).length;
  const conflict = results.filter((r) => r.status === 409);
  expect(ok).toBe(1);
  expect(conflict.length).toBe(4);
  expect(conflict.every((r) => r.json?.error === "request_in_progress")).toBe(true);
  expect(stack.fake.requestCount()).toBe(1); // only one hit upstream
});

it("C5: replay after completion is byte-identical and bills only once", async () => {
  const m = await setup("c5b");
  stack.fake.setLatency(0);
  const id = "req-c5-replay";
  const first = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(first.status).toBe(200);
  await drainUsageQueue(stack.db, 1);
  const replay = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(replay.status).toBe(200);
  expect(replay.text).toBe(first.text); // byte-identical
  const rows = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  expect(rows[0]!.c).toBe(1);
  expect(stack.fake.requestCount()).toBe(1);
});

it("C5: a non-2xx response is NOT cached (next same-id request re-hits upstream)", async () => {
  const m = await setup("c5c");
  stack.fake.setLatency(0);
  const id = "req-c5-error";
  stack.fake.forceStatus("tok-c5c-1", 401);
  const first = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(first.status).toBeGreaterThanOrEqual(400);
  const upstreamCallsAfterFirst = stack.fake.requestCount();
  stack.fake.forceStatus("tok-c5c-1", 200);
  const second = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(second.status).toBe(200);
  expect(stack.fake.requestCount()).toBeGreaterThan(upstreamCallsAfterFirst);
});
