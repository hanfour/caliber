import { describe, it, expect } from "vitest";
import { resolveModelAlias } from "@caliber/gateway-core/models";
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

// Regression guard for the whole dotted-version finding: a bare-family alias
// must still resolve against the SHIPPED static fallback catalog (it would
// passthrough — wasAlias=false — with the pre-fix hyphen-only matcher).
describe("staticFallbackCatalog resolves its own bare-family aliases", () => {
  it("openai gpt-5 → gpt-5.4 against the default fallback catalog", () => {
    const r = resolveModelAlias("gpt-5", "openai", staticFallbackCatalog("openai", {}));
    expect(r.resolved).toBe("gpt-5.4");
    expect(r.wasAlias).toBe(true);
  });

  it("anthropic claude-haiku → newest dated id against the default fallback catalog", () => {
    const r = resolveModelAlias(
      "claude-haiku",
      "anthropic",
      staticFallbackCatalog("anthropic", {}),
    );
    expect(r.resolved).toBe("claude-haiku-4-5-20251001");
  });
});
