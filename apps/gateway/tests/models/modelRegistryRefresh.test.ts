import { describe, it, expect, vi } from "vitest";
import { ModelRegistry } from "../../src/models/modelRegistry.js";

describe("ModelRegistry.refreshOnce", () => {
  it("discovers in-use buckets and populates each from fetch", async () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    const discover = vi.fn(async () => [
      { platform: "anthropic" as const, baseUrl: "https://api.anthropic.com", credentialType: "oauth" as const },
    ]);
    const fetcher = vi.fn(async () => [{ id: "claude-haiku-4-5-20251001", created: 7 }]);
    await reg.refreshOnce({ discoverBuckets: discover, fetchForBucket: fetcher });
    expect(reg.get({ platform: "anthropic", baseUrl: "https://api.anthropic.com", credentialType: "oauth" }))
      .toEqual([{ id: "claude-haiku-4-5-20251001", created: 7 }]);
  });
  it("leaves a bucket on fallback when its fetch returns []", async () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    await reg.refreshOnce({
      discoverBuckets: async () => [{ platform: "anthropic", baseUrl: "u", credentialType: "oauth" }],
      fetchForBucket: async () => [],
    });
    expect(reg.get({ platform: "anthropic", baseUrl: "u", credentialType: "oauth" }).some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
  });
});
