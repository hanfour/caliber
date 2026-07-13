import { describe, it, expect } from "vitest";
import { curveScore, scoreSectionContinuous } from "../../src/engine/continuousScorer.js";
import type { Section } from "../../src/rubric/schema.js";
import type { SignalHit } from "../../src/engine/types.js";

const section: Section = {
  id: "eff",
  name: "Efficiency",
  weight: "25%",
  scoring: { mode: "continuous" },
  signals: [
    { type: "facet_claude_helpfulness", id: "help", gte: 3.5, points: 60, curve: { zeroAt: 2.5, fullAt: 4.5 } },
    { type: "facet_friction_per_session", id: "fric", lte: 1, points: 40, curve: { zeroAt: 3.0, fullAt: 0.5 } },
  ],
} as Section;

const hit = (over: Partial<SignalHit>): SignalHit => ({
  id: "help",
  type: "facet_claude_helpfulness",
  hit: true,
  value: 0,
  ...over,
});

describe("curveScore", () => {
  it("clamps and interpolates ascending curves", () => {
    const c = { zeroAt: 2.5, fullAt: 4.5 };
    expect(curveScore(2.5, c)).toBe(0);
    expect(curveScore(4.5, c)).toBe(1);
    expect(curveScore(3.5, c)).toBeCloseTo(0.5);
    expect(curveScore(1, c)).toBe(0);
    expect(curveScore(5, c)).toBe(1);
  });

  it("handles descending (inverted) curves", () => {
    const c = { zeroAt: 3.0, fullAt: 0.5 };
    expect(curveScore(3.0, c)).toBe(0);
    expect(curveScore(0.5, c)).toBe(1);
    expect(curveScore(1.75, c)).toBeCloseTo(0.5);
    expect(curveScore(10, c)).toBe(0);
    expect(curveScore(0, c)).toBe(1);
  });
});

describe("scoreSectionContinuous", () => {
  it("weights subscores by points onto the 0..scaleMax scale", () => {
    const hits = [
      hit({ id: "help", value: 4.5, sampleCount: 10 }), // subscore 1 → 60 pts
      hit({ id: "fric", type: "facet_friction_per_session", value: 1.75, sampleCount: 10 }), // 0.5 → 20 pts
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.mode).toBe("continuous");
    expect(r.score).toBeCloseTo(96); // 120 × (60+20)/100
    expect(r.maxScore).toBe(120);
    expect(r.signals.find((s) => s.id === "help")!.earnedPoints).toBeCloseTo(60);
    expect(r.signals.find((s) => s.id === "fric")!.maxPoints).toBe(40);
  });

  it("redistributes points when a minor signal lacks samples", () => {
    const hits = [
      hit({ id: "help", value: 3.5, sampleCount: 10 }), // 0.5
      hit({ id: "fric", type: "facet_friction_per_session", value: 0, sampleCount: 0 }), // unusable (40 pts < half)
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.score).toBeCloseTo(60); // 120 × (60×0.5)/60
  });

  it("returns null score when usable points drop below half", () => {
    const hits = [
      hit({ id: "help", value: 5, sampleCount: 2 }), // 2 < minSamples 5 → unusable (60 pts)
      hit({ id: "fric", type: "facet_friction_per_session", value: 0.5, sampleCount: 10 }),
    ];
    const r = scoreSectionContinuous(section, hits, 120);
    expect(r.score).toBeNull();
  });

  it("respects a custom minSamples", () => {
    const s2 = { ...section, minSamples: 1 } as Section;
    const hits = [
      hit({ id: "help", value: 4.5, sampleCount: 2 }),
      hit({ id: "fric", type: "facet_friction_per_session", value: 0.5, sampleCount: 2 }),
    ];
    expect(scoreSectionContinuous(s2, hits, 120).score).toBeCloseTo(120);
  });

  it("treats non-facet signals as usable whenever they carry any sample", () => {
    const s3 = {
      ...section,
      signals: [
        { type: "cache_read_ratio", id: "cache", gte: 0.2, points: 100, curve: { zeroAt: 0.1, fullAt: 0.6 } },
      ],
    } as Section;
    const r = scoreSectionContinuous(
      s3,
      [hit({ id: "cache", type: "cache_read_ratio", value: 0.35, sampleCount: 3 })],
      120,
    );
    expect(r.score).toBeCloseTo(60); // (0.35-0.1)/(0.5) = 0.5 → 120×0.5
  });
});
