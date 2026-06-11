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

  // Finding 1 — refreshOnce must NEVER reject. A discovery failure is logged and
  // the cycle is skipped (per-bucket loop never runs).
  it("resolves (never rejects) and logs when discoverBuckets rejects", async () => {
    const warn = vi.fn();
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {}, logger: { warn } });
    const fetcher = vi.fn(async () => [{ id: "claude-haiku-4-5-20251001", created: 7 }]);
    await expect(
      reg.refreshOnce({
        discoverBuckets: () => Promise.reject(new Error("db down")),
        fetchForBucket: fetcher,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    // no bucket set → still serves fallback
    expect(reg.buckets()).toEqual([]);
    expect(
      reg
        .get({ platform: "anthropic", baseUrl: "https://api.anthropic.com", credentialType: "oauth" })
        .some((e) => e.id.startsWith("claude-haiku-")),
    ).toBe(true);
  });

  // Finding 2 — a bad/empty refresh leaves the old cache in place (bounded
  // stale-while-revalidate); within TTL the stale live catalog is still served,
  // past TTL it degrades to fallback.
  it("empty refresh retains the stale catalog within TTL, then expires to fallback", async () => {
    let t = 1_000;
    const reg = new ModelRegistry({
      env: {},
      fallbackMetric: () => {},
      now: () => t,
      ttlMs: 100,
    });
    const bucket = { platform: "anthropic" as const, baseUrl: "u", credentialType: "oauth" as const };
    reg.set(bucket, [{ id: "live-id", created: 9 }]);
    // a refresh that returns [] leaves the old cache untouched
    await reg.refreshOnce({
      discoverBuckets: async () => [bucket],
      fetchForBucket: async () => [],
    });
    // within TTL the (stale) live catalog is still served
    expect(reg.get(bucket)).toEqual([{ id: "live-id", created: 9 }]);
    // advance past TTL → fallback
    t += 200;
    expect(reg.get(bucket).some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
  });
});
