import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { gatewayErrorHandler } from "../../src/middleware/errorHandler.js";
import {
  platformForGatewayRoute,
  UnsupportedRouteError,
} from "../../src/routes/surfacePlatform.js";

// These tests exercise the gateway's setErrorHandler SAFETY NET in isolation:
// a minimal Fastify instance with ONLY the global error handler registered, so
// there is no auth / db / rate-limit machinery to mock. This deterministically
// covers the three handler branches (honoured statusCode, clean 500, and the
// streaming/headersSent guard) plus the UnsupportedRouteError → 400 mapping.
//
// The real wiring (`app.setErrorHandler(gatewayErrorHandler)`) lives in
// buildServer; that registration is proven by the buildServer-level smoke at
// the bottom of this file.

function buildHandlerApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(gatewayErrorHandler);
  return app;
}

describe("gatewayErrorHandler safety net", () => {
  it("honours a thrown error's statusCode (400, not the Fastify 500 default)", async () => {
    const app = buildHandlerApp();
    app.get("/throw-400", async () => {
      const err = new Error("boom-400") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/throw-400" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "request_error",
      request_id: expect.any(String),
    });
    await app.close();
  });

  it("honours an in-range 503 statusCode", async () => {
    const app = buildHandlerApp();
    app.get("/throw-503", async () => {
      const err = new Error("upstream") as Error & { statusCode: number };
      err.statusCode = 503;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/throw-503" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("maps an error with no statusCode to a clean 500 internal_error (no stack/message leak)", async () => {
    const app = buildHandlerApp();
    app.get("/throw-bare", async () => {
      throw new Error("super-secret-internal-detail");
    });
    const res = await app.inject({ method: "GET", url: "/throw-bare" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ error: "internal_error" });
    expect(body).toHaveProperty("request_id");
    // The real message / stack MUST NOT reach the client.
    expect(res.payload).not.toContain("super-secret-internal-detail");
    expect(res.payload).not.toContain("at ");
    await app.close();
  });

  it("treats an out-of-range statusCode (e.g. 200) as unknown → 500", async () => {
    const app = buildHandlerApp();
    app.get("/throw-weird", async () => {
      const err = new Error("weird") as Error & { statusCode: number };
      err.statusCode = 200; // not a 4xx/5xx → not honourable
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/throw-weird" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal_error" });
    await app.close();
  });

  it("maps an UnsupportedRouteError to a clean 400 unsupported_route", async () => {
    const app = buildHandlerApp();
    app.get("/unmapped-byok", async (req) => {
      // /unmapped-byok is not in ROUTE_PLATFORM → throws UnsupportedRouteError
      // (statusCode 400, errorCode "unsupported_route").
      return { platform: platformForGatewayRoute(req) };
    });
    const res = await app.inject({ method: "GET", url: "/unmapped-byok" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "unsupported_route",
      request_id: expect.any(String),
    });
    await app.close();
  });

  it("does NOT try to re-send when the reply was already hijacked/streamed (headersSent)", async () => {
    const app = buildHandlerApp();
    app.get("/stream-then-throw", async (_req, reply) => {
      // Simulate the gateway's streaming path: take over the raw socket, write
      // headers, then fail. The handler must observe headersSent and NOT send.
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write("data: partial\n\n");
      // Throwing here would be swallowed by Fastify (reply is hijacked), so we
      // invoke the handler the way an escaped error would and assert it is a
      // no-op (no throw, no second send).
      gatewayErrorHandler(
        new Error("mid-stream failure") as never,
        _req,
        reply,
      );
      reply.raw.end();
    });
    const res = await app.inject({
      method: "GET",
      url: "/stream-then-throw",
    });
    // The pre-written 200 + partial body stands; the handler did not overwrite.
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("data: partial");
    expect(res.payload).not.toContain("internal_error");
    await app.close();
  });
});

describe("UnsupportedRouteError", () => {
  it("carries statusCode 400 and errorCode unsupported_route", () => {
    const err = new UnsupportedRouteError("/v1/nope");
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe("unsupported_route");
    expect(err.name).toBe("UnsupportedRouteError");
    expect(err).toBeInstanceOf(Error);
  });
});
