import { describe, it, expect } from "vitest";
import {
  parseDeliveryQualityResponse,
  QUALITY_ADJUSTMENT_LIMIT,
} from "../../src/delivery/qualityParser";

/** True when `s` contains a UTF-16 surrogate that is not part of a valid pair. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const validPayload = {
  qualityAdjustment: 5,
  narrative: "這是一段繁體中文的敘述，說明交付品質的評估結果。",
  evidence: [
    { repo: "org/repo", prNumber: 1, quote: "console.log('x')", reason: "clean fix" },
  ],
};

describe("parseDeliveryQualityResponse", () => {
  it("accepts raw valid JSON", () => {
    const result = parseDeliveryQualityResponse(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.qualityAdjustment).toBe(5);
      expect(result.narrative).toBe(validPayload.narrative);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toEqual({
        repo: "org/repo",
        prNumber: 1,
        quote: "console.log('x')",
        reason: "clean fix",
      });
    }
  });

  it("accepts a ```json fenced payload", () => {
    const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
    const result = parseDeliveryQualityResponse(fenced);
    expect(result.ok).toBe(true);
  });

  it("accepts a prose-wrapped payload by extracting the outermost {...}", () => {
    const prose = `Here is my assessment:\n${JSON.stringify(validPayload)}\nHope that helps!`;
    const result = parseDeliveryQualityResponse(prose);
    expect(result.ok).toBe(true);
  });

  it("clamps an out-of-range positive adjustment to +15 (still ok:true)", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, qualityAdjustment: 40 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.qualityAdjustment).toBe(QUALITY_ADJUSTMENT_LIMIT);
      expect(QUALITY_ADJUSTMENT_LIMIT).toBe(15);
    }
  });

  it("clamps an out-of-range negative adjustment to -15 (still ok:true)", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, qualityAdjustment: -99 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.qualityAdjustment).toBe(-15);
    }
  });

  it("missing narrative → ok:false", () => {
    const { narrative, ...rest } = validPayload;
    const result = parseDeliveryQualityResponse(JSON.stringify(rest));
    expect(result.ok).toBe(false);
  });

  it("empty-string narrative → ok:false", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, narrative: "" }),
    );
    expect(result.ok).toBe(false);
  });

  it("non-number adjustment → ok:false", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, qualityAdjustment: "high" }),
    );
    expect(result.ok).toBe(false);
  });

  it("garbage input → ok:false", () => {
    const result = parseDeliveryQualityResponse("not json at all, just noise");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("trims evidence beyond 5 items to 5, without failing the whole response", () => {
    const evidence = Array.from({ length: 8 }, (_, i) => ({
      repo: "org/repo",
      prNumber: i,
      quote: `quote ${i}`,
      reason: `reason ${i}`,
    }));
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, evidence }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toHaveLength(5);
    }
  });

  it("slices quotes longer than 200 chars down to 200", () => {
    const longQuote = "x".repeat(500);
    const result = parseDeliveryQualityResponse(
      JSON.stringify({
        ...validPayload,
        evidence: [{ repo: "org/repo", prNumber: 1, quote: longQuote, reason: "r" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence[0]!.quote).toHaveLength(200);
      expect(result.evidence[0]!.quote).toBe(longQuote.slice(0, 200));
    }
  });

  it("drops malformed evidence items instead of failing the whole response", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({
        ...validPayload,
        evidence: [
          { repo: "org/repo", prNumber: 1, quote: "good one", reason: "ok" },
          { repo: "org/repo" /* missing prNumber, quote, reason */ },
          "not even an object",
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]!.quote).toBe("good one");
    }
  });

  it("missing evidence array entirely still succeeds with an empty evidence list", () => {
    const { evidence, ...rest } = validPayload;
    const result = parseDeliveryQualityResponse(JSON.stringify(rest));
    // narrative + adjustment are load-bearing; evidence is optional/best-effort
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toEqual([]);
    }
  });

  it("never emits a lone surrogate when the 200-char quote slice bisects an emoji", () => {
    // The 200th char boundary lands inside "😀"'s surrogate pair — the exact
    // shape that made keyword.ts's evidence quotes crash the jsonb write
    // (see packages/evaluator/src/signals/keyword.ts).
    const quote = "x".repeat(199) + "😀" + "tail";
    const result = parseDeliveryQualityResponse(
      JSON.stringify({
        ...validPayload,
        evidence: [{ repo: "org/repo", prNumber: 1, quote, reason: "r" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hasLoneSurrogate(result.evidence[0]!.quote)).toBe(false);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });

  it("sanitizes a raw lone surrogate in narrative", () => {
    const result = parseDeliveryQualityResponse(
      JSON.stringify({ ...validPayload, narrative: "bad\uD800text" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hasLoneSurrogate(result.narrative)).toBe(false);
      expect(result.narrative).toBe("badtext");
    }
  });
});
