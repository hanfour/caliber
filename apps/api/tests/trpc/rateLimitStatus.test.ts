// Integration guard for #193 follow-up: the rate-limited response must carry
// HTTP 429, not 500. @fastify/rate-limit@10 THROWS the errorResponseBuilder
// return value (index.js: `throw params.errorResponseBuilder(...)`); fastify's
// default error handler then derives the status from the thrown value's
// `.statusCode`. The default builder returns an Error with statusCode 429, but
// our tRPC-shaped payload is a plain object/array — so without an explicit
// (non-enumerable) statusCode fastify falls back to 500 while still serialising
// the payload as the body (body-right, status-wrong). This test boots a minimal
// fastify app wired exactly like apps/api/src/server.ts and asserts the status.
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { trpcTooManyRequestsBody } from "../../src/trpc/rateLimitError.js";

async function buildRateLimitedApp(max: number): Promise<FastifyInstance> {
  const app = Fastify();
  // Same wiring as server.ts: max requests per window, keyed per user/ip, with
  // the tRPC-shaped error body.
  await app.register(rateLimit, {
    max,
    timeWindow: "1 minute",
    keyGenerator: () => "fixed-key", // one shared bucket so the test is deterministic
    errorResponseBuilder: (req, context) =>
      trpcTooManyRequestsBody(req, context.after),
  });
  app.get("/trpc/*", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate-limit response status (#193 follow-up)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("non-batch over-limit request → HTTP 429 with a single tRPC envelope", async () => {
    app = await buildRateLimitedApp(1);
    const ok = await app.inject({ method: "GET", url: "/trpc/me.session" });
    expect(ok.statusCode).toBe(200);

    const limited = await app.inject({ method: "GET", url: "/trpc/me.session" });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(Array.isArray(body)).toBe(false);
    expect(body).toMatchObject({
      error: {
        code: -32029,
        data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path: "me.session" },
      },
    });
    // The internal statusCode marker must NOT leak into the wire body.
    expect(limited.body).not.toContain("statusCode");
  });

  it("batched over-limit request → HTTP 429 with an array body", async () => {
    app = await buildRateLimitedApp(1);
    await app.inject({ method: "GET", url: "/trpc/a.b?batch=1" });
    const limited = await app.inject({
      method: "GET",
      url: "/trpc/a.b,c.d?batch=1",
    });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});
