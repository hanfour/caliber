import { describe, it, expect } from "vitest";
import { rubricSchema } from "../../src/rubric/schema.js";
import { scoreWithRules } from "../../src/engine/ruleEngine.js";
import {
  platformRubricV2En,
  platformRubricV2ZhHant,
  platformRubricV2Ja,
} from "../../src/rubrics/platformV2.js";
import type { FacetRowInput } from "../../src/signals/facet.js";

const mk = (over: Partial<FacetRowInput>): FacetRowInput => ({
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 1,
  bugsCaughtCount: 0,
  codexErrorsCount: 0,
  userSatisfaction: 4,
  ...over,
});

const strongMember = Array.from({ length: 20 }, () =>
  mk({ claudeHelpfulness: 5, frictionCount: 0, bugsCaughtCount: 1, userSatisfaction: 5 }),
);
const averageMember = Array.from({ length: 20 }, (_, i) =>
  mk({
    claudeHelpfulness: 3,
    frictionCount: 2,
    bugsCaughtCount: i % 5 === 0 ? 1 : 0,
    outcome: i % 3 === 0 ? "partial" : i % 3 === 1 ? "success" : "failure",
    userSatisfaction: 3,
  }),
);
const weakMember = Array.from({ length: 20 }, () =>
  mk({
    claudeHelpfulness: 2,
    frictionCount: 3,
    codexErrorsCount: 2,
    outcome: "abandoned",
    userSatisfaction: 2,
  }),
);

const score = (facetRows: FacetRowInput[]) =>
  scoreWithRules({ rubric: platformRubricV2En, usageRows: [], bodyRows: [], facetRows })
    .totalScore;

describe("platform rubric v2", () => {
  it("all three locales pass schema validation", () => {
    for (const r of [platformRubricV2En, platformRubricV2ZhHant, platformRubricV2Ja]) {
      expect(rubricSchema.safeParse(r).success).toBe(true);
    }
  });

  it("weights sum to 100% and every continuous section's points sum to 100", () => {
    const weights = platformRubricV2En.sections.map((s) => Number(s.weight.replace("%", "")));
    expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
    for (const s of platformRubricV2En.sections) {
      const pts = s.signals.reduce((a, sig) => a + (sig.points ?? 0), 0);
      expect(pts).toBe(100);
    }
  });

  it("DISCRIMINATES: strong > average > weak, none saturated at 120", () => {
    const strong = score(strongMember)!;
    const avg = score(averageMember)!;
    const weak = score(weakMember)!;
    expect(strong).toBeGreaterThan(avg);
    expect(avg).toBeGreaterThan(weak);
    expect(strong - weak).toBeGreaterThan(20); // 至少拉出 20 分級距
    expect(avg).toBeLessThan(110);
    expect(weak).toBeLessThan(80);
  });

  it("returns insufficient data below minSamples instead of a fake score", () => {
    const r = scoreWithRules({
      rubric: platformRubricV2En,
      usageRows: [],
      bodyRows: [],
      facetRows: strongMember.slice(0, 3), // < 5
    });
    expect(r.totalScore).toBeNull();
    expect(r.insufficientData).toBe(true);
  });

  it("locale rubrics do not share nested references with the en rubric (immutability hazard)", () => {
    // ZhHant/Ja are built by spreading platformRubricV2En; if their nested
    // objects/arrays are the same reference, mutating one locale's signal in
    // place (e.g. a future calibration pass) silently corrupts every locale.
    for (const locale of [platformRubricV2ZhHant, platformRubricV2Ja]) {
      expect(locale.scale).not.toBe(platformRubricV2En.scale);
      expect(locale.noiseFilters).not.toBe(platformRubricV2En.noiseFilters);
      expect(locale.sections).not.toBe(platformRubricV2En.sections);
      for (let i = 0; i < locale.sections.length; i++) {
        expect(locale.sections[i]).not.toBe(platformRubricV2En.sections[i]);
        expect(locale.sections[i]!.signals).not.toBe(platformRubricV2En.sections[i]!.signals);
        for (let j = 0; j < locale.sections[i]!.signals.length; j++) {
          expect(locale.sections[i]!.signals[j]).not.toBe(
            platformRubricV2En.sections[i]!.signals[j],
          );
        }
      }

      // Content must still match en (minus name/description/locale), proving
      // the clone is a deep structural copy, not a divergent rebuild.
      expect(locale.scale).toEqual(platformRubricV2En.scale);
      expect(locale.noiseFilters).toEqual(platformRubricV2En.noiseFilters);
      expect(locale.sections.map((s) => s.id)).toEqual(
        platformRubricV2En.sections.map((s) => s.id),
      );
      expect(locale.sections.map((s) => s.signals)).toEqual(
        platformRubricV2En.sections.map((s) => s.signals),
      );
    }
  });
});
