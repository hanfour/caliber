import { describe, it, expect } from "vitest";
import { resolveModelAlias } from "../../src/models/resolveModelAlias.js";
import type { ModelCatalogEntry } from "../../src/models/types.js";

const A: ModelCatalogEntry[] = [
  { id: "claude-haiku-4-5-20251001", created: 2000 },
  { id: "claude-haiku-3-5-20241022", created: 1000 },
  { id: "claude-sonnet-4-5-20250929", created: 1500 },
];

describe("resolveModelAlias (anthropic)", () => {
  it("passes an exact concrete id through untouched", () => {
    const r = resolveModelAlias("claude-haiku-3-5-20241022", "anthropic", A);
    expect(r).toEqual({ resolved: "claude-haiku-3-5-20241022", wasAlias: false });
  });
  it("resolves a bare family to the newest by created", () => {
    const r = resolveModelAlias("claude-haiku", "anthropic", A);
    expect(r.resolved).toBe("claude-haiku-4-5-20251001");
    expect(r.wasAlias).toBe(true);
    expect(r.family).toBe("claude-haiku");
  });
  it("resolves a -latest suffix to the newest", () => {
    const r = resolveModelAlias("claude-sonnet-latest", "anthropic", A);
    expect(r.resolved).toBe("claude-sonnet-4-5-20250929");
    expect(r.wasAlias).toBe(true);
  });
});

describe("resolveModelAlias edge cases", () => {
  it("ties break to lexicographically-greatest id", () => {
    const cat = [
      { id: "claude-opus-4-1-20250101", created: 9 },
      { id: "claude-opus-4-2-20250101", created: 9 },
    ];
    expect(resolveModelAlias("claude-opus", "anthropic", cat).resolved).toBe("claude-opus-4-2-20250101");
  });
  it("passes through when family has no members", () => {
    expect(resolveModelAlias("claude-nope", "anthropic", A)).toEqual({ resolved: "claude-nope", wasAlias: false });
  });
  it("passes through on empty catalog", () => {
    expect(resolveModelAlias("claude-haiku", "anthropic", [])).toEqual({ resolved: "claude-haiku", wasAlias: false });
  });
});

describe("resolveModelAlias (anthropic, conservative family matching)", () => {
  it("passes a bare brand 'claude' through (does NOT collapse across families)", () => {
    expect(resolveModelAlias("claude", "anthropic", A)).toEqual({
      resolved: "claude",
      wasAlias: false,
    });
  });
  it("passes 'claude-latest' through (next segment is a name word, not a version)", () => {
    expect(resolveModelAlias("claude-latest", "anthropic", A)).toEqual({
      resolved: "claude-latest",
      wasAlias: false,
    });
  });
  it("still resolves a real digit-led family alias (claude-haiku)", () => {
    expect(resolveModelAlias("claude-haiku", "anthropic", A).resolved).toBe(
      "claude-haiku-4-5-20251001",
    );
  });
  it("auto-handles a new tier without an allowlist (claude-fable → claude-fable-5)", () => {
    const cat: ModelCatalogEntry[] = [{ id: "claude-fable-5", created: 100 }];
    const r = resolveModelAlias("claude-fable", "anthropic", cat);
    expect(r.resolved).toBe("claude-fable-5");
    expect(r.wasAlias).toBe(true);
  });
});

const O: ModelCatalogEntry[] = [
  { id: "gpt-5-2025-08-01", created: 100 },
  { id: "gpt-5-2025-09-01", created: 200 },
  { id: "gpt-5-mini-2025-09-01", created: 250 },
];
describe("resolveModelAlias (openai, conservative)", () => {
  it("resolves gpt-5 to newest gpt-5 dated id, NOT gpt-5-mini", () => {
    const r = resolveModelAlias("gpt-5", "openai", O);
    expect(r.resolved).toBe("gpt-5-2025-09-01");
  });
  it("resolves gpt-5-mini family separately", () => {
    expect(resolveModelAlias("gpt-5-mini", "openai", O).resolved).toBe("gpt-5-mini-2025-09-01");
  });
  it("passes through when family is ambiguous/unmatched", () => {
    expect(resolveModelAlias("gpt", "openai", O)).toEqual({ resolved: "gpt", wasAlias: false });
  });
});

describe("resolveModelAlias (openai, dotted-version catalog)", () => {
  const dotted: ModelCatalogEntry[] = [
    { id: "gpt-5.4-mini", created: 100 },
    { id: "gpt-5.4", created: 100 },
  ];

  it("resolves gpt-5 to gpt-5.4 (mini excluded)", () => {
    const r = resolveModelAlias("gpt-5", "openai", dotted);
    expect(r.resolved).toBe("gpt-5.4");
    expect(r.wasAlias).toBe(true);
  });

  it("resolves gpt-5-latest to gpt-5.4", () => {
    const r = resolveModelAlias("gpt-5-latest", "openai", dotted);
    expect(r.resolved).toBe("gpt-5.4");
    expect(r.wasAlias).toBe(true);
  });

  it("picks the newest dotted version by created", () => {
    const cat: ModelCatalogEntry[] = [
      { id: "gpt-5.3", created: 1 },
      { id: "gpt-5.4", created: 2 },
    ];
    expect(resolveModelAlias("gpt-5", "openai", cat).resolved).toBe("gpt-5.4");
  });

  it("does NOT swallow a different family (gpt-5 vs gpt-50.1)", () => {
    const cat: ModelCatalogEntry[] = [{ id: "gpt-50.1", created: 1 }];
    expect(resolveModelAlias("gpt-5", "openai", cat)).toEqual({
      resolved: "gpt-5",
      wasAlias: false,
    });
  });

  it("excludes non-version suffix segments (gpt-5-codex) but resolves real versions", () => {
    const cat: ModelCatalogEntry[] = [
      { id: "gpt-5-codex", created: 5 },
      { id: "gpt-5.4", created: 1 },
    ];
    expect(resolveModelAlias("gpt-5", "openai", cat).resolved).toBe("gpt-5.4");
  });

  it("passes through when the only suffix is non-version (gpt-5-codex alone)", () => {
    const cat: ModelCatalogEntry[] = [{ id: "gpt-5-codex", created: 5 }];
    expect(resolveModelAlias("gpt-5", "openai", cat)).toEqual({
      resolved: "gpt-5",
      wasAlias: false,
    });
  });
});
