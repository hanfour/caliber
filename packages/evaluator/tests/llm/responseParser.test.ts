import { describe, it, expect } from "vitest";
import { parseLlmResponse } from "../../src/llm/responseParser";

const validResponse = {
  userReport: {
    title: "Your AI-assisted development report",
    summary: "You use the available tools effectively.",
    strengths: [
      { sectionId: "interaction", title: "Clear iteration", detail: "You validate changes frequently." },
    ],
    growthAreas: [
      {
        sectionId: "quality",
        title: "Broaden verification",
        detail: "Some changes lack integration coverage.",
        action: "Add one boundary test before finishing each change.",
      },
    ],
    nextSteps: [
      {
        sectionId: "quality",
        title: "Add boundary tests",
        rationale: "This directly improves the quality rubric.",
        priority: "high" as const,
      },
    ],
  },
  adminReport: {
    title: "Engineering effectiveness report",
    executiveSummary: "Performance is stable with a verification gap.",
    performanceAssessment: "The rubric signals show strong iteration and uneven integration coverage.",
    strengths: [
      { sectionId: "interaction", title: "Clear iteration", detail: "Frequent validation is visible." },
    ],
    concerns: [
      {
        sectionId: "quality",
        title: "Verification depth",
        detail: "Integration checks are inconsistent.",
        severity: "medium" as const,
        evidenceRequestIds: ["r1"],
      },
    ],
    coachingPlan: [
      {
        sectionId: "quality",
        title: "Review boundary coverage",
        rationale: "Align review practice with the rubric.",
        priority: "high" as const,
        successMeasure: "Every risky change includes an integration test.",
      },
    ],
    calibrationNotes: ["Compare only against the configured rubric."],
    dataLimitations: ["The sample covers one evaluation window."],
  },
  evidence: [
    { quote: "can we compare?", requestId: "r1", rationale: "option-seeking" },
  ],
  sectionAdjustments: [
    { sectionId: "interaction", adjustment: 5, rationale: "clear options" },
  ],
};

describe("parseLlmResponse", () => {
  it("accepts a valid response object", () => {
    const r = parseLlmResponse(validResponse);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userReport.summary).toContain("tools effectively");
      expect(r.adminReport.concerns[0]?.evidenceRequestIds).toEqual(["r1"]);
      expect(r.evidence).toHaveLength(1);
      expect(r.sectionAdjustments).toHaveLength(1);
    }
  });

  it("accepts a JSON string and parses it", () => {
    const raw = JSON.stringify(validResponse);
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(true);
  });

  it("accepts JSON wrapped in markdown code fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify(validResponse) +
      "\n```";
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userReport.title).toContain("development report");
  });

  it("returns ok:false on malformed JSON string", () => {
    const r = parseLlmResponse("{not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/json|parse/i);
  });

  it("returns ok:false on missing audience reports", () => {
    const r = parseLlmResponse({ evidence: [], sectionAdjustments: [] });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on non-numeric adjustment", () => {
    const r = parseLlmResponse({
      ...validResponse,
      sectionAdjustments: [
        { sectionId: "x", adjustment: "high" as unknown as number, rationale: "r" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("clamps adjustment outside [-10, 10] by rejecting", () => {
    const r = parseLlmResponse({
      ...validResponse,
      sectionAdjustments: [{ sectionId: "x", adjustment: 50, rationale: "r" }],
    });
    expect(r.ok).toBe(false);
  });

  it("never throws on any input — null, undefined, arrays", () => {
    expect(() => parseLlmResponse(null)).not.toThrow();
    expect(() => parseLlmResponse(undefined)).not.toThrow();
    expect(() => parseLlmResponse([])).not.toThrow();
    expect(() => parseLlmResponse(42)).not.toThrow();
    expect(parseLlmResponse(null).ok).toBe(false);
    expect(parseLlmResponse(undefined).ok).toBe(false);
  });
});
