import { afterAll, beforeAll, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";

let fake: FakeUpstream;
beforeAll(async () => { fake = await startFakeUpstream(); });
afterAll(async () => { await fake.stop(); });

it("returns 200 anthropic JSON by default and counts the request", async () => {
  fake.reset();
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-A", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5 }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { type?: string };
  expect(body.type).toBe("message");
  expect(fake.requestCount()).toBe(1);
  expect(fake.errorCount()).toBe(0);
});

it("forces a status per credential token", async () => {
  fake.reset();
  fake.forceStatus("tok-dead", 401);
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-dead", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5 }),
  });
  expect(res.status).toBe(401);
  expect(fake.errorCount()).toBe(1);
});

it("adds latency before responding", async () => {
  fake.reset();
  fake.setLatency(120);
  const t0 = Date.now();
  await fetch(`${fake.baseUrl}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer tok-O", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
  });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
});

it("streams SSE when stream:true", async () => {
  fake.reset();
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-A", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5, stream: true }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
});
