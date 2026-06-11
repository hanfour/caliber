import { describe, it, expect } from "vitest";
import { ModelRegistry } from "../../src/models/modelRegistry.js";
import type { BucketKey } from "@caliber/gateway-core/models";

const bk = (credentialType: "api_key" | "oauth"): BucketKey => ({
  platform: "anthropic", baseUrl: "https://api.anthropic.com", credentialType,
});

describe("ModelRegistry", () => {
  it("returns static fallback when a bucket has not been refreshed", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    const cat = reg.get(bk("oauth"));
    expect(cat.some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
  });
  it("returns the cached live catalog after set()", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    reg.set(bk("oauth"), [{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    expect(reg.get(bk("oauth"))).toEqual([{ id: "claude-haiku-4-5-20251001", created: 9 }]);
  });
  it("keeps buckets isolated by credential type", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    reg.set(bk("api_key"), [{ id: "only-apikey", created: 9 }]);
    expect(reg.get(bk("oauth")).some((e) => e.id === "only-apikey")).toBe(false);
  });
  it("emits the fallback metric when serving fallback", () => {
    const seen: string[] = [];
    const reg = new ModelRegistry({ env: {}, fallbackMetric: (p, t) => seen.push(`${p}:${t}`) });
    reg.get(bk("oauth"));
    expect(seen).toContain("anthropic:oauth");
  });

  // Finding 2 — a fresh (within-TTL) cached non-empty catalog is served without
  // falling back.
  it("serves a within-TTL cached catalog without emitting the fallback metric", () => {
    let t = 0;
    const seen: string[] = [];
    const reg = new ModelRegistry({
      env: {},
      fallbackMetric: (p, type) => seen.push(`${p}:${type}`),
      now: () => t,
      ttlMs: 100,
    });
    reg.set(bk("oauth"), [{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    t = 50; // still fresh
    expect(reg.get(bk("oauth"))).toEqual([{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    expect(seen).toEqual([]);
  });

  // Finding 2 — once the cache entry ages past ttlMs the stale catalog is no
  // longer served; we degrade to fallback and emit the fallback metric.
  it("expires a cached catalog past ttlMs and falls back", () => {
    let t = 0;
    const seen: string[] = [];
    const reg = new ModelRegistry({
      env: {},
      fallbackMetric: (p, type) => seen.push(`${p}:${type}`),
      now: () => t,
      ttlMs: 100,
    });
    reg.set(bk("oauth"), [{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    t = 0; // fresh
    expect(reg.get(bk("oauth"))).toEqual([{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    t = 150; // past TTL
    const cat = reg.get(bk("oauth"));
    expect(cat.some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
    expect(cat).not.toEqual([{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    expect(seen).toContain("anthropic:oauth");
  });
});
