import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const W = 3, M = 8;
beforeAll(async () => { stack = await bootStack({ maxWait: W }); }, 120_000);
afterAll(async () => { await stack.teardown(); });

it("C3: single user, account not a bottleneck — first W admit, rest 429 wait_queue_full", async () => {
  const orgId = await seedOrg(stack.db, "c3");
  const userId = await seedUser(stack.db, "c3", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c3", 1, "pool");
  await seedAccount(stack.db, orgId, "c3", 1, { userId: null, concurrency: 1000 }); // slots never the bottleneck
  stack.fake.setLatency(800); // keep the W admitted requests in-flight

  const results = await Promise.all(Array.from({ length: M }, () => postMessages(stack.baseUrl, m.rawKey)));

  const admitted = results.filter((r) => r.status === 200).length;
  const shed = results.filter((r) => r.status === 429);
  expect(admitted).toBe(W);
  expect(shed.length).toBe(M - W);
  expect(shed.every((r) => r.json?.error === "wait_queue_full")).toBe(true);
  expect(shed.every((r) => typeof r.json?.maxWait === "number")).toBe(true);
});

it("C3: after the queue drains, new requests admit again", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c3b");
  const userId = await seedUser(stack.db, "c3b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c3b", 1, "pool");
  await seedAccount(stack.db, orgId, "c3b", 1, { userId: null, concurrency: 1000 });
  stack.fake.setLatency(0); // fast — each completes and dequeues immediately

  for (let i = 0; i < W + 2; i++) {
    const r = await postMessages(stack.baseUrl, m.rawKey); // serial → never exceeds W in-flight
    expect(r.status).toBe(200);
  }
});
