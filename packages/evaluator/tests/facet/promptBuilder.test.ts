import { describe, it, expect } from "vitest";
import {
  CURRENT_PROMPT_VERSION,
  buildFacetPrompt,
  truncateTurns,
  type Turn,
} from "../../src/facet/promptBuilder";

describe("CURRENT_PROMPT_VERSION", () => {
  it("is 2", () => {
    expect(CURRENT_PROMPT_VERSION).toBe(2);
  });
});

describe("buildFacetPrompt", () => {
  it("system prompt mentions schema fields and 'Output JSON only'", () => {
    const { system } = buildFacetPrompt({ turns: [] });
    expect(system).toContain("sessionType");
    expect(system).toContain("feature_dev");
    expect(system).toContain("claudeHelpfulness");
    expect(system).toContain("Output JSON only");
  });

  it("v2 prompt declares userSatisfaction in the schema and bumps the version", () => {
    expect(CURRENT_PROMPT_VERSION).toBe(2);
    const { system } = buildFacetPrompt({ turns: [] });
    expect(system).toContain('"userSatisfaction"');
  });

  it("user prompt formats turns with role: content", () => {
    const turns: Turn[] = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "looking at the code" },
    ];
    const { user } = buildFacetPrompt({ turns });
    expect(user).toContain("user: fix the bug");
    expect(user).toContain("assistant: looking at the code");
  });

  it("returns maxTokens of 256", () => {
    const { maxTokens } = buildFacetPrompt({ turns: [] });
    expect(maxTokens).toBe(256);
  });
});

describe("truncateTurns", () => {
  it("keeps all turns when under budget", () => {
    const turns: Turn[] = [
      { role: "user", content: "a".repeat(40) },
      { role: "assistant", content: "b".repeat(40) },
    ];
    const result = truncateTurns(turns, 8000);
    expect(result.truncated).toBe(false);
    expect(result.turns).toEqual(turns);
  });

  it("truncates when over budget, preserving first and last and inserting placeholder", () => {
    // Each turn ~250 tokens (1000 chars). Budget 1000 → head=400, tail=400.
    const turns: Turn[] = [
      { role: "user", content: "A".repeat(1000) }, // first
      { role: "assistant", content: "B".repeat(1000) },
      { role: "user", content: "C".repeat(1000) },
      { role: "assistant", content: "D".repeat(1000) },
      { role: "user", content: "E".repeat(1000) }, // last
    ];
    const result = truncateTurns(turns, 1000);
    expect(result.truncated).toBe(true);
    // First turn preserved
    expect(result.turns[0]).toEqual(turns[0]);
    // Last turn preserved
    expect(result.turns[result.turns.length - 1]).toEqual(
      turns[turns.length - 1],
    );
    // Placeholder turn inserted in the middle
    const placeholder = result.turns.find((t) =>
      t.content.startsWith("[..."),
    );
    expect(placeholder).toBeDefined();
    expect(placeholder?.content).toMatch(/turns/);
    expect(placeholder?.content).toMatch(/tokens truncated/);
  });

  it("returns empty turns array unchanged with truncated: false", () => {
    const result = truncateTurns([], 8000);
    expect(result.turns).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
