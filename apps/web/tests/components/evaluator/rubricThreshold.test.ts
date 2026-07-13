import { describe, it, expect } from "vitest";
import { formatThreshold } from "@/components/evaluator/rubricThreshold";

describe("formatThreshold", () => {
  it("keyword with minRatio → percentage-of-bodies phrasing", () => {
    expect(
      formatThreshold({ type: "keyword", id: "k", minRatio: 0.5 }),
    ).toBe("≥ 50% of bodies contain a term");
  });

  it("keyword without minRatio → any-body phrasing", () => {
    expect(formatThreshold({ type: "keyword", id: "k" })).toBe(
      "any body contains a term",
    );
  });

  it("threshold gte → metric ≥ n", () => {
    expect(
      formatThreshold({ type: "threshold", id: "t", metric: "iteration_count", gte: 3 }),
    ).toBe("iteration_count ≥ 3");
  });

  it("threshold between → metric in [a, b]", () => {
    expect(
      formatThreshold({ type: "threshold", id: "t", metric: "requests", between: [2, 8] }),
    ).toBe("requests in [2, 8]");
  });

  it("refusal_rate lte → refusal_rate ≤ n", () => {
    expect(formatThreshold({ type: "refusal_rate", id: "r", lte: 0.1 })).toBe(
      "refusal_rate ≤ 0.1",
    );
  });

  it("client_mix → ≥ ratio of expected clients", () => {
    expect(
      formatThreshold({ type: "client_mix", id: "c", minRatio: 0.6 }),
    ).toBe("≥ 60% from expected clients");
  });

  it("simple gte families → type ≥ n", () => {
    expect(formatThreshold({ type: "tool_diversity", id: "d", gte: 2 })).toBe(
      "tool_diversity ≥ 2",
    );
  });

  it("extended_thinking_used → used ≥ minCount times", () => {
    expect(
      formatThreshold({ type: "extended_thinking_used", id: "e", minCount: 1 }),
    ).toBe("extended thinking used ≥ 1 times");
  });

  it("unknown/malformed → empty string (graceful)", () => {
    expect(formatThreshold({ type: "mystery", id: "x" } as never)).toBe("");
  });

  it("facet_user_satisfaction gte → mean satisfaction ≥ n", () => {
    expect(
      formatThreshold({ type: "facet_user_satisfaction", id: "x", gte: 3.5 }),
    ).toBe("mean satisfaction ≥ 3.5");
  });

  it("signal with curve → appends · curve zeroAt→fullAt", () => {
    expect(
      formatThreshold({
        type: "facet_user_satisfaction",
        id: "x",
        gte: 3.5,
        curve: { zeroAt: 2.5, fullAt: 4.5 },
      }),
    ).toBe("mean satisfaction ≥ 3.5 · curve 2.5→4.5");
  });
});
