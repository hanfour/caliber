import { describe, it, expect } from "vitest";
import { rubricSchema } from "../../src/rubric/schema.js";

const tier = { score: 100, label: "Standard", criteria: ["c"] };

const legacyRubric = {
  name: "legacy",
  version: "1.0.0",
  locale: "en",
  sections: [
    {
      id: "s1",
      name: "S1",
      weight: "100%",
      standard: tier,
      superior: { ...tier, score: 120, label: "Superior" },
      signals: [{ type: "refusal_rate", id: "rr", lte: 0.2 }],
    },
  ],
};

const continuousSection = {
  id: "eff",
  name: "Efficiency",
  weight: "25%",
  scoring: { mode: "continuous" },
  minSamples: 5,
  signals: [
    {
      type: "facet_claude_helpfulness",
      id: "help",
      gte: 3.5,
      points: 50,
      curve: { zeroAt: 2.5, fullAt: 4.5 },
    },
    {
      type: "facet_user_satisfaction",
      id: "sat",
      gte: 3.5,
      points: 30,
      curve: { zeroAt: 2.5, fullAt: 4.5 },
    },
    {
      type: "facet_bugs_caught",
      id: "bugs",
      gte: 1,
      normalize: "per_session",
      points: 20,
      curve: { zeroAt: 0, fullAt: 0.5 },
    },
  ],
};

describe("rubric schema v2", () => {
  it("still parses a legacy v1 rubric unchanged (backward compat)", () => {
    const parsed = rubricSchema.parse(legacyRubric);
    expect(parsed.sections[0]!.standard!.score).toBe(100);
    expect(parsed.scale).toBeUndefined();
  });

  it("parses scale + a continuous section without standard/superior", () => {
    const parsed = rubricSchema.parse({
      ...legacyRubric,
      scale: { max: 120, pass: 108 },
      sections: [continuousSection],
    });
    expect(parsed.scale).toEqual({ max: 120, pass: 108 });
    expect(parsed.sections[0]!.scoring?.mode).toBe("continuous");
    expect(parsed.sections[0]!.standard).toBeUndefined();
  });

  it("rejects a tiered section missing standard/superior", () => {
    const bad = {
      ...legacyRubric,
      sections: [{ ...legacyRubric.sections[0], standard: undefined, superior: undefined }],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a continuous section whose signal lacks points or curve", () => {
    const bad = {
      ...legacyRubric,
      sections: [
        {
          ...continuousSection,
          signals: [{ type: "refusal_rate", id: "rr", lte: 0.2 }], // 無 points/curve
        },
      ],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a curve where zeroAt === fullAt", () => {
    const bad = {
      ...legacyRubric,
      sections: [
        {
          ...continuousSection,
          signals: [
            {
              type: "facet_claude_helpfulness",
              id: "h",
              gte: 3,
              points: 100,
              curve: { zeroAt: 3, fullAt: 3 },
            },
          ],
        },
      ],
    };
    expect(rubricSchema.safeParse(bad).success).toBe(false);
  });

  it("parses facet_user_satisfaction and bounds gte to 1..5", () => {
    expect(
      rubricSchema.safeParse({
        ...legacyRubric,
        sections: [
          { ...continuousSection, signals: [continuousSection.signals[1]] },
        ],
      }).success,
    ).toBe(true);
    expect(
      rubricSchema.safeParse({
        ...legacyRubric,
        sections: [
          {
            ...continuousSection,
            signals: [
              { type: "facet_user_satisfaction", id: "sat", gte: 6, points: 100, curve: { zeroAt: 2, fullAt: 5 } },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
