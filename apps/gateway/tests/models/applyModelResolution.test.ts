import { describe, it, expect } from "vitest";
import { applyModelResolution } from "../../src/models/applyModelResolution.js";

const reg = {
  get: (_b: unknown) => [{ id: "claude-haiku-4-5-20251001", created: 9 }],
} as unknown as import("../../src/models/modelRegistry.js").ModelRegistry;

describe("applyModelResolution", () => {
  it("single bucket: resolves up-front, returns upstreamModel + cacheable=true", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: true,
      registry: reg, listCandidateTypes: async () => ["oauth"],
    });
    expect(r.upfront?.upstreamModel).toBe("claude-haiku-4-5-20251001");
    expect(r.cacheable).toBe(true);
    expect(r.requestedModel).toBe("claude-haiku");
  });
  it("mixed bucket: no up-front rewrite, cacheable=false, perAttempt resolver provided", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: true,
      registry: reg, listCandidateTypes: async () => ["oauth", "api_key"],
    });
    expect(r.upfront).toBeNull();
    expect(r.cacheable).toBe(false);
    expect(r.perAttempt("oauth").upstreamModel).toBe("claude-haiku-4-5-20251001");
  });
  it("disabled: passthrough, cacheable true, requested unchanged", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: false,
      registry: reg, listCandidateTypes: async () => ["oauth"],
    });
    expect(r.upfront).toBeNull();
    expect(r.cacheable).toBe(true);
    expect(r.perAttempt("oauth").upstreamModel).toBe("claude-haiku");
  });
});
