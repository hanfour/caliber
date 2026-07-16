import { describe, it, expect } from "vitest";
import {
  buildDeliveryQualityPrompt,
  QUALITY_RETRY_SUFFIX,
  type QualityPromptPr,
} from "../../src/delivery/qualityPrompt";

const pr = (over: Partial<QualityPromptPr> = {}): QualityPromptPr => ({
  repoFullName: "org/repo",
  number: 42,
  title: "Fix the thing",
  body: "This fixes the thing.",
  diff: "diff --git a/x b/x\n+console.log('x')\n",
  reviewComments: ["nice catch"],
  ...over,
});

describe("buildDeliveryQualityPrompt", () => {
  it("system pins the JSON-only output contract, the ±15 bound, and zh-TW narrative instruction", () => {
    const { system } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 90,
      sectionSummary: [{ key: "throughput", score: 80 }],
      prs: [pr()],
    });
    expect(system).toContain("qualityAdjustment");
    expect(system).toContain("-15");
    expect(system).toContain("15");
    expect(system).toContain("narrative");
    expect(system).toContain("evidence");
    expect(system).toMatch(/zh-TW|繁體中文/);
    expect(system).toMatch(/JSON/);
    expect(system.toLowerCase()).toContain("only");
  });

  it("user contains quant total, section scores, and each PR's repo#number + truncated diff", () => {
    const prA = pr({ repoFullName: "org/alpha", number: 1, title: "Alpha PR" });
    const prB = pr({ repoFullName: "org/beta", number: 2, title: "Beta PR", body: null });
    const { user } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 77,
      sectionSummary: [
        { key: "throughput", score: 80 },
        { key: "timeliness", score: null },
      ],
      prs: [prA, prB],
    });
    expect(user).toContain("30");
    expect(user).toContain("77");
    expect(user).toContain("throughput");
    expect(user).toContain("80");
    expect(user).toContain("timeliness");
    expect(user).toContain("org/alpha#1");
    expect(user).toContain("Alpha PR");
    expect(user).toContain("org/beta#2");
    expect(user).toContain("Beta PR");
    expect(user).toContain("(no description)");
    expect(user).toContain(prA.diff);
    expect(user).toContain("nice catch");
  });

  it("exports the exact retry suffix constant", () => {
    expect(QUALITY_RETRY_SUFFIX).toBe(
      "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object — no fences, no commentary.",
    );
  });
});
