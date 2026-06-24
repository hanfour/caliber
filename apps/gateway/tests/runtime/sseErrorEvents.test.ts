// Plan 5A PR 9j — unit coverage for the consolidated SSE error
// serializers + failover-collapse responder. Wire format is part of
// the contract every Anthropic / OpenAI Chat / OpenAI Responses SDK
// client depends on, so we lock these shapes down explicitly.

import { describe, it, expect, vi } from "vitest";
import {
  serializeAnthropicSseError,
  serializeChatSseError,
  serializeResponsesSseError,
  failoverErrorPair,
  respondStreamFailoverCollapse,
} from "../../src/runtime/sseErrorEvents.js";
import {
  AllUpstreamsFailed,
  FatalUpstreamError,
  RateLimitedError,
} from "../../src/runtime/failoverLoop.js";

describe("serializeAnthropicSseError", () => {
  it("emits the Anthropic SDK-shaped error event with `event:` prefix", () => {
    const out = serializeAnthropicSseError("overloaded", "Slow down", "req-1");
    expect(out.startsWith("event: error\ndata: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(out.split("\ndata: ")[1]!.trim());
    expect(payload).toMatchObject({
      type: "error",
      error: { type: "overloaded", message: "Slow down", request_id: "req-1" },
    });
  });
});

describe("serializeChatSseError", () => {
  it("emits Chat-shaped data chunk WITHOUT `event:` prefix", () => {
    const out = serializeChatSseError("rate_limited", "Too fast", "req-2");
    expect(out.startsWith("data: ")).toBe(true);
    expect(out).not.toContain("event:");
    expect(out.endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(out.replace(/^data: /, "").trim());
    expect(payload).toEqual({
      error: { type: "rate_limited", message: "Too fast", request_id: "req-2" },
    });
  });
});

describe("serializeResponsesSseError", () => {
  it("emits OpenAI Responses-shaped error event with `kind` (not `type`)", () => {
    const out = serializeResponsesSseError(
      "upstream_502",
      "bad gateway",
      "req-3",
    );
    expect(out.startsWith("event: error\ndata: ")).toBe(true);
    const payload = JSON.parse(out.split("\ndata: ")[1]!.trim());
    expect(payload).toMatchObject({
      type: "error",
      error: {
        kind: "upstream_502",
        message: "bad gateway",
        request_id: "req-3",
      },
    });
    // Crucial: Responses uses `kind`, not `type`, on the inner object.
    expect(payload.error).not.toHaveProperty("type");
  });
});

describe("failoverErrorPair", () => {
  it("uses FatalUpstreamError.reason + canonical .message", () => {
    // FatalUpstreamError formats its own message from reason+statusCode.
    const err = new FatalUpstreamError(401, "auth_failed");
    expect(failoverErrorPair(err)).toEqual({
      kind: "auth_failed",
      message: "fatal upstream: auth_failed (401)",
    });
  });

  it("uses canonical phrasing for AllUpstreamsFailed with attempt count", () => {
    const err = new AllUpstreamsFailed(["a1", "a2", "a3"]);
    expect(failoverErrorPair(err)).toEqual({
      kind: "all_upstreams_failed",
      message: "all upstreams failed (attempted=3)",
    });
  });
});

describe("respondStreamFailoverCollapse", () => {
  function makeFakeReply(headersSent: boolean): {
    reply: {
      raw: {
        headersSent: boolean;
        writeHead: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
    };
    writes: string[];
    ends: string[];
    writeHeads: Array<[number, Record<string, string>]>;
  } {
    const writes: string[] = [];
    const ends: string[] = [];
    const writeHeads: Array<[number, Record<string, string>]> = [];
    return {
      reply: {
        raw: {
          headersSent,
          writeHead: vi.fn((code: number, hdrs: Record<string, string>) => {
            writeHeads.push([code, hdrs]);
          }),
          write: vi.fn((chunk: string) => writes.push(chunk)),
          end: vi.fn((chunk?: string) => {
            if (typeof chunk === "string") ends.push(chunk);
          }),
        },
      },
      writes,
      ends,
      writeHeads,
    };
  }

  it("AllUpstreamsFailed + headersSent → SSE error chunk + end", () => {
    const f = makeFakeReply(true);
    const err = new AllUpstreamsFailed(["a", "b"]);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      err,
      "req-1",
      serializeChatSseError,
    );
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toContain("all_upstreams_failed");
    expect(f.writes[0]).toContain("attempted=2");
    expect(f.reply.raw.end).toHaveBeenCalled();
    expect(f.writeHeads).toHaveLength(0);
  });

  it("AllUpstreamsFailed + no headers → JSON 503 with attempted_count", () => {
    const f = makeFakeReply(false);
    const err = new AllUpstreamsFailed(["a", "b", "c"]);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      err,
      "req-x",
      serializeChatSseError,
    );
    expect(f.writeHeads).toEqual([
      [503, { "content-type": "application/json" }],
    ]);
    expect(f.ends[0]).toContain('"error":"all_upstreams_failed"');
    expect(f.ends[0]).toContain('"request_id":"req-x"');
  });

  it("RateLimitedError + headersSent → SSE rate_limited error chunk + end", () => {
    const f = makeFakeReply(true);
    const err = new RateLimitedError(42);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      err,
      "req-rl",
      serializeChatSseError,
    );
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toContain("rate_limited");
    expect(f.writes[0]).toContain("42s");
    expect(f.reply.raw.end).toHaveBeenCalled();
    expect(f.writeHeads).toHaveLength(0);
  });

  it("RateLimitedError + no headers → JSON 429 + Retry-After header", () => {
    const f = makeFakeReply(false);
    const err = new RateLimitedError(30);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      err,
      "req-rl2",
      serializeChatSseError,
    );
    expect(f.writeHeads).toEqual([
      [429, { "content-type": "application/json", "retry-after": "30" }],
    ]);
    expect(f.ends[0]).toContain('"error":"rate_limited"');
    expect(f.ends[0]).toContain('"retry_after":30');
    expect(f.ends[0]).toContain('"request_id":"req-rl2"');
  });

  it("FatalUpstreamError + no headers → JSON err.statusCode", () => {
    const f = makeFakeReply(false);
    const err = new FatalUpstreamError(401, "auth_failed");
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      err,
      "req-9",
      serializeResponsesSseError,
    );
    expect(f.writeHeads[0]![0]).toBe(401);
    expect(f.ends[0]).toContain('"error":"auth_failed"');
  });

  it("Unexpected error + no headers → JSON 500", () => {
    const f = makeFakeReply(false);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      new Error("kaboom"),
      "req-z",
      serializeChatSseError,
    );
    expect(f.writeHeads[0]![0]).toBe(500);
    expect(f.ends[0]).toBe('{"error":"internal_error"}');
  });

  it("Unexpected error + headersSent → just ends the stream", () => {
    const f = makeFakeReply(true);
    respondStreamFailoverCollapse(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.reply as any,
      new Error("kaboom"),
      "req-y",
      serializeChatSseError,
    );
    expect(f.writes).toHaveLength(0);
    expect(f.writeHeads).toHaveLength(0);
    expect(f.reply.raw.end).toHaveBeenCalled();
  });
});
