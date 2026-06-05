import { describe, it, expect } from "vitest";
import { trpcTooManyRequestsBody } from "../../src/trpc/rateLimitError.js";

describe("trpcTooManyRequestsBody", () => {
  it("non-batch request → single tRPC error envelope with httpStatus 429", () => {
    const body = trpcTooManyRequestsBody(
      { url: "/trpc/me.session" },
      "44 seconds",
    );
    expect(Array.isArray(body)).toBe(false);
    expect(body).toMatchObject({
      error: {
        message: "Rate limit exceeded, retry in 44 seconds",
        code: -32029,
        data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path: "me.session" },
      },
    });
  });

  it("batched request → array of one envelope per comma-joined op", () => {
    const body = trpcTooManyRequestsBody(
      {
        url: "/trpc/me.session,organizations.list,teams.list?batch=1&input=%7B%7D",
      },
      "30 seconds",
    );
    expect(Array.isArray(body)).toBe(true);
    const arr = body as Array<{ error: { data: { path: string | null } } }>;
    expect(arr).toHaveLength(3);
    expect(arr.map((e) => e.error.data.path)).toEqual([
      "me.session",
      "organizations.list",
      "teams.list",
    ]);
    // Every entry carries httpStatus 429 so the web client suppresses retry.
    for (const e of arr) {
      expect(e.error).toMatchObject({
        code: -32029,
        data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
      });
    }
  });

  it("batched single-op request → array of length 1", () => {
    const body = trpcTooManyRequestsBody(
      { url: "/trpc/teams.list?batch=1" },
      "1 second",
    );
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(1);
  });

  it("missing/empty url → single envelope with null path (never throws)", () => {
    expect(() => trpcTooManyRequestsBody({}, "5 seconds")).not.toThrow();
    const body = trpcTooManyRequestsBody({}, "5 seconds");
    expect(body).toMatchObject({ error: { data: { path: null } } });
  });

  it("carries a non-enumerable statusCode 429 for fastify, hidden from JSON", () => {
    // @fastify/rate-limit throws this value; fastify's error handler reads
    // `.statusCode` for the response code. It must be 429 (not the 500 default)
    // but must not appear in the serialised body. Checked for both shapes.
    for (const url of ["/trpc/me.session", "/trpc/a.b,c.d?batch=1"]) {
      const body = trpcTooManyRequestsBody({ url }, "5 seconds") as {
        statusCode?: number;
      };
      expect(body.statusCode).toBe(429);
      expect(
        Object.prototype.propertyIsEnumerable.call(body, "statusCode"),
      ).toBe(false);
      expect(JSON.stringify(body)).not.toContain("statusCode");
    }
  });
});
