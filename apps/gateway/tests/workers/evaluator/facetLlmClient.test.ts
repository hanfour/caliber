import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";
import { createFacetLlmClient } from "../../../src/workers/evaluator/facetLlmClient.js";
import { EVAL_PIN_HEADER } from "../../../src/runtime/evalAccountPin.js";

function fakeRedis(key: string | null): Redis {
  return { get: vi.fn().mockResolvedValue(key) } as unknown as Redis;
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createFacetLlmClient", () => {
  it("sends the eval account pin header so loopback calls schedule onto the pinned upstream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = createFacetLlmClient({
      redis: fakeRedis("ak_test"),
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "org-1",
      evalAccountId: "acct-pin-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.call({
      model: "claude-haiku-4-5",
      system: "s",
      user: "u",
      maxTokens: 256,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers[EVAL_PIN_HEADER]).toBe("acct-pin-1");
    expect(headers["Authorization"]).toBe("Bearer ak_test");
  });

  it("omits the pin header when the org has no pinned eval account", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = createFacetLlmClient({
      redis: fakeRedis("ak_test"),
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "org-1",
      evalAccountId: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.call({
      model: "claude-haiku-4-5",
      system: "s",
      user: "u",
      maxTokens: 256,
    });

    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(EVAL_PIN_HEADER in headers).toBe(false);
  });
});
