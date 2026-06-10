import { describe, it, expect } from "vitest";
import { staticFallbackCatalog } from "../../src/models/staticFallback.js";

describe("staticFallbackCatalog", () => {
  it("returns a non-empty anthropic catalog with current families", () => {
    const cat = staticFallbackCatalog("anthropic", {});
    const ids = cat.map((e) => e.id);
    expect(ids.some((i) => i.startsWith("claude-haiku-"))).toBe(true);
    expect(ids.some((i) => i.startsWith("claude-sonnet-"))).toBe(true);
    expect(ids.some((i) => i.startsWith("claude-opus-"))).toBe(true);
  });
  it("applies an env override entry", () => {
    const cat = staticFallbackCatalog("anthropic", {
      GATEWAY_MODEL_REGISTRY_FALLBACK_ANTHROPIC: "claude-haiku-9-9-29991231",
    });
    expect(cat.map((e) => e.id)).toContain("claude-haiku-9-9-29991231");
  });
});
