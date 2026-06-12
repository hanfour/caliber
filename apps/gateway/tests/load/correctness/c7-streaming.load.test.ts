import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterAll(async () => { await stack.teardown(); });

/** Stream /v1/messages; returns the full SSE text + firstTokenMs (time to first byte). */
async function streamMessages(rawKey: string): Promise<{ status: number; sse: string; firstTokenMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${stack.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const reader = res.body!.getReader();
  let firstTokenMs = -1, sse = "";
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
    sse += dec.decode(value, { stream: true });
  }
  return { status: res.status, sse, firstTokenMs };
}

it("C7: concurrent streams each get a complete, uncorrupted SSE; firstTokenMs positive; slots released after", async () => {
  const orgId = await seedOrg(stack.db, "c7");
  const userId = await seedUser(stack.db, "c7", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c7", 1, "pool");
  const acct = await seedAccount(stack.db, orgId, "c7", 1, { userId: null, concurrency: 1000 });
  stack.fake.setFirstTokenDelay(20);

  const streams = await Promise.all(Array.from({ length: 4 }, () => streamMessages(m.rawKey)));
  for (const s of streams) {
    expect(s.status).toBe(200);
    expect(s.sse).toContain("event: message_start");
    expect(s.sse).toContain("event: message_stop");
    expect(s.firstTokenMs).toBeGreaterThan(0);
  }

  // Slot release lands in a `finally` that may run just after the response body closes,
  // so allow a short window for the per-account slot ZSET to drain to 0 (documented
  // release-timing tolerance — still asserts the ZSET reaches 0).
  const { waitFor } = await import("../drainUsageQueue.js");
  await waitFor(async () => (await stack.redis.zcard(`slots:account:${acct.id}`)) === 0, 5000);
  const held = await stack.redis.zcard(`slots:account:${acct.id}`);
  expect(held).toBe(0);
});
