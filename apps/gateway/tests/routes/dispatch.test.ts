import { describe, it, expect, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { autoRoute, forcePlatform } from "../../src/routes/dispatch.js";
import type { GroupContext } from "../../src/runtime/groupDispatch.js";

function makeReply() {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code: vi.fn(function (this: FastifyReply, c: number) {
      sent.code = c;
      return this;
    }),
    send: vi.fn(function (this: FastifyReply, body: unknown) {
      sent.body = body;
      return this;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

function makeReq(ctx: GroupContext | null): FastifyRequest {
  return { gwGroupContext: ctx } as unknown as FastifyRequest;
}

const ctxAnthropic: GroupContext = {
  groupId: "g1",
  platform: "anthropic",
  rateMultiplier: 1,
  isExclusive: false,
  isLegacy: false,
  policy: "pool",
  isByok: false,
};
const ctxOpenai: GroupContext = { ...ctxAnthropic, platform: "openai" };

describe("autoRoute", () => {
  it("dispatches to the per-platform handler when one matches", async () => {
    const anthropic = vi.fn();
    const openai = vi.fn();
    const handler = autoRoute({ anthropic, openai });
    const { reply } = makeReply();

    await handler(makeReq(ctxOpenai), reply);
    expect(openai).toHaveBeenCalledOnce();
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("falls back to `fallback` when the platform has no specific handler", async () => {
    const fallback = vi.fn();
    const handler = autoRoute({}, fallback);
    const { reply } = makeReply();

    await handler(makeReq(ctxOpenai), reply);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("returns 404 platform_not_supported_by_route when no handler + no fallback", async () => {
    const handler = autoRoute({});
    const { reply, sent } = makeReply();

    await handler(makeReq(ctxOpenai), reply);
    expect(sent.code).toBe(404);
    expect(sent.body).toMatchObject({ error: "platform_not_supported_by_route" });
  });

  it("defaults to `anthropic` when gwGroupContext is null (preserves 4A)", async () => {
    const anthropic = vi.fn();
    const openai = vi.fn();
    const handler = autoRoute({ anthropic, openai });
    const { reply } = makeReply();

    await handler(makeReq(null), reply);
    expect(anthropic).toHaveBeenCalledOnce();
    expect(openai).not.toHaveBeenCalled();
  });

  it("propagates handler return values", async () => {
    const inner = vi.fn().mockResolvedValue("inner-result");
    const handler = autoRoute({ anthropic: inner });
    const { reply } = makeReply();
    const out = await handler(makeReq(ctxAnthropic), reply);
    expect(out).toBe("inner-result");
  });
});

describe("forcePlatform", () => {
  it("invokes the wrapped handler when ctx.platform matches", async () => {
    const inner = vi.fn();
    const handler = forcePlatform("openai", inner);
    const { reply } = makeReply();

    await handler(makeReq(ctxOpenai), reply);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("returns 401 group_required when ctx is null", async () => {
    const inner = vi.fn();
    const handler = forcePlatform("openai", inner);
    const { reply, sent } = makeReply();

    await handler(makeReq(null), reply);
    expect(inner).not.toHaveBeenCalled();
    expect(sent.code).toBe(401);
    expect(sent.body).toMatchObject({ error: "group_required" });
  });

  it("returns 403 route_platform_mismatch when ctx.platform differs", async () => {
    const inner = vi.fn();
    const handler = forcePlatform("openai", inner);
    const { reply, sent } = makeReply();

    await handler(makeReq(ctxAnthropic), reply);
    expect(inner).not.toHaveBeenCalled();
    expect(sent.code).toBe(403);
    expect(sent.body).toMatchObject({
      error: "route_platform_mismatch",
      expected: "openai",
      actual: "anthropic",
    });
  });
});
