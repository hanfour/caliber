import { describe, it, expect } from "vitest";
import {
  buildDeliveryQualityPrompt,
  QUALITY_RETRY_SUFFIX,
  MAX_REVIEW_COMMENTS,
  PR_BODY_MAX_CHARS,
  REVIEW_COMMENT_MAX_CHARS,
  PR_TITLE_MAX_CHARS,
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

  it("never emits a lone surrogate when the cap bisects an emoji", () => {
    // "😀" is a surrogate pair (2 code units). Placing it so the body cap lands
    // between its halves is the emoji-at-the-boundary case: a naive slice would
    // leave a trailing lone high surrogate in the prompt, risking an upstream
    // 400 that burns all three BullMQ retries on an identical payload.
    const { user } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 88,
      sectionSummary: [],
      prs: [
        {
          repoFullName: "acme/web",
          number: 1,
          title: "t",
          body: "B".repeat(PR_BODY_MAX_CHARS - 1) + "😀" + "tail",
          diff: "diff --git a/x b/x",
          reviewComments: ["C".repeat(REVIEW_COMMENT_MAX_CHARS - 1) + "😀" + "tail"],
        },
      ],
    });
    // Every surrogate code unit left in the prompt must be part of a valid pair.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(user)).toBe(false);
    expect(user).toContain("…[truncated]");
  });

  it("caps an oversized PR body, comment and title with a visible marker", () => {
    const { user } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 88,
      sectionSummary: [],
      prs: [
        {
          repoFullName: "acme/web",
          number: 1,
          title: "T".repeat(PR_TITLE_MAX_CHARS + 50),
          body: "B".repeat(PR_BODY_MAX_CHARS + 5_000),
          diff: "diff --git a/x b/x",
          reviewComments: ["C".repeat(REVIEW_COMMENT_MAX_CHARS + 500), "short one"],
        },
      ],
    });
    expect(user).not.toContain("B".repeat(PR_BODY_MAX_CHARS + 1));
    expect(user).not.toContain("C".repeat(REVIEW_COMMENT_MAX_CHARS + 1));
    expect(user).not.toContain("T".repeat(PR_TITLE_MAX_CHARS + 1));
    expect(user).toContain("…[truncated]");
    expect(user).toContain("short one"); // untouched sibling
  });

  it("leaves under-cap content byte-identical", () => {
    const { user } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 88,
      sectionSummary: [],
      prs: [
        {
          repoFullName: "acme/web",
          number: 1,
          title: "fix: thing",
          body: "short body",
          diff: "diff --git a/x b/x",
          reviewComments: ["nice"],
        },
      ],
    });
    expect(user).toContain("short body");
    expect(user).toContain("nice");
    expect(user).not.toContain("…[truncated]");
  });

  it("caps the comment COUNT at MAX_REVIEW_COMMENTS", () => {
    const { user } = buildDeliveryQualityPrompt({
      windowDays: 30,
      quantTotal: 88,
      sectionSummary: [],
      prs: [
        {
          repoFullName: "acme/web",
          number: 1,
          title: "t",
          body: null,
          diff: "d",
          reviewComments: Array.from(
            { length: MAX_REVIEW_COMMENTS + 5 },
            (_, i) => `comment-${i}`,
          ),
        },
      ],
    });
    expect(user).toContain(`comment-${MAX_REVIEW_COMMENTS - 1}`);
    expect(user).not.toContain(`comment-${MAX_REVIEW_COMMENTS}`);
  });
});
