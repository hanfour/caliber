import { describe, it, expect } from "vitest";
import { scoreWithRules } from "../../src/engine/ruleEngine";
import type { Rubric } from "../../src/rubric/schema";
import type { UsageRow, BodyRow } from "../../src/signals/types";

function mkRubric(sections: Rubric["sections"]): Rubric {
  return { name: "test", version: "1.0.0", locale: "en", sections };
}

describe("scoreWithRules", () => {
  it("returns standard score for section with no superior rules and no hits", () => {
    const rubric = mkRubric([
      {
        id: "interaction",
        name: "Interaction",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [{ type: "cache_read_ratio", id: "cr1", gte: 0.5 }],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(100);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(report.sectionScores[0]!.score).toBe(100);
  });

  it("hits superior when all signals hit (no superiorRules)", () => {
    const rubric = mkRubric([
      {
        id: "cache",
        name: "Cache",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [{ type: "cache_read_ratio", id: "cr1", gte: 0.5 }],
      },
    ]);
    const usage: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    const report = scoreWithRules({ rubric, usageRows: usage, bodyRows: [] });
    expect(report.totalScore).toBe(120);
  });

  it("uses superiorRules: requires minStrongHits + minSupportHits", () => {
    const rubric = mkRubric([
      {
        id: "quality",
        name: "Quality",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [
          { type: "cache_read_ratio", id: "cr1", gte: 0.5 },
          { type: "model_diversity", id: "md1", gte: 2 },
          { type: "tool_diversity", id: "td1", gte: 2 },
        ],
        superiorRules: {
          strongThresholds: ["cr1"],
          supportThresholds: ["md1", "td1"],
          minStrongHits: 1,
          minSupportHits: 2,
        },
      },
    ]);
    // Only cache_read_ratio hits — strong met (1/1) but support = 0 → standard
    const oneHit: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    expect(
      scoreWithRules({ rubric, usageRows: oneHit, bodyRows: [] }).totalScore,
    ).toBe(100);
  });

  it("applies weights across multiple sections", () => {
    const rubric = mkRubric([
      {
        id: "a",
        name: "A",
        weight: "60%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [],
      },
      {
        id: "b",
        name: "B",
        weight: "40%",
        standard: { score: 80, label: "S", criteria: [] },
        superior: { score: 100, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    // 100 × 0.6 + 80 × 0.4 = 92
    expect(report.totalScore).toBeCloseTo(92, 5);
  });

  it("clamps total to [0, 120]", () => {
    const rubric = mkRubric([
      {
        id: "x",
        name: "X",
        weight: "100%",
        standard: { score: 200, label: "S", criteria: [] }, // intentionally weird
        superior: { score: 300, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(120);
  });

  it("populates dataQuality coverage correctly", () => {
    const rubric = mkRubric([
      {
        id: "x",
        name: "X",
        weight: "100%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const usage: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
      {
        requestId: "r2",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    const bodies: BodyRow[] = [
      {
        requestId: "r1",
        stopReason: "stop",
        clientUserAgent: null,
        clientSessionId: null,
        requestParams: null,
        responseBody: null,
        requestBody: null,
      },
    ];
    const report = scoreWithRules({
      rubric,
      usageRows: usage,
      bodyRows: bodies,
    });
    expect(report.dataQuality.totalRequests).toBe(2);
    expect(report.dataQuality.capturedRequests).toBe(1);
    expect(report.dataQuality.coverageRatio).toBe(0.5);
  });

  it("keyword signal hits when any body contains term", () => {
    const rubric = mkRubric([
      {
        id: "interaction",
        name: "I",
        weight: "100%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [
          {
            type: "keyword",
            id: "kw1",
            in: "request_body",
            terms: ["options"],
            caseSensitive: false,
          },
        ],
      },
    ]);
    const bodies: BodyRow[] = [
      {
        requestId: "r1",
        stopReason: "stop",
        clientUserAgent: null,
        clientSessionId: null,
        requestParams: null,
        responseBody: null,
        requestBody: {
          messages: [
            { role: "user", content: "What are my options here?" },
          ],
        },
      },
    ];
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: bodies });
    expect(report.totalScore).toBe(120);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(
      report.sectionScores[0]!.signals[0]!.evidence?.length ?? 0,
    ).toBeGreaterThan(0);
  });

  // #261: a keyword signal with minRatio requires that at least that FRACTION
  // of bodies contain a term, so high-volume telemetry (1000s of bodies where
  // a term appears a handful of times) no longer auto-hits and saturates to
  // superior. Absent minRatio, the legacy any-hit behavior is preserved.
  describe("keyword minRatio (#261)", () => {
    function kwRubric(minRatio?: number) {
      return mkRubric([
        {
          id: "interaction",
          name: "I",
          weight: "100%",
          standard: { score: 100, label: "S", criteria: [] },
          superior: { score: 120, label: "Sup", criteria: [] },
          signals: [
            {
              type: "keyword",
              id: "kw",
              in: "request_body",
              terms: ["refactor"],
              caseSensitive: false,
              ...(minRatio !== undefined ? { minRatio } : {}),
            },
          ],
        },
      ]);
    }

    function bodies(hitCount: number, total: number): BodyRow[] {
      return Array.from({ length: total }, (_, i) => ({
        requestId: `r${i}`,
        stopReason: null,
        clientUserAgent: null,
        clientSessionId: null,
        requestParams: null,
        responseBody: null,
        requestBody: {
          messages: [
            {
              role: "user",
              content: i < hitCount ? "please refactor this" : "hello",
            },
          ],
        },
      }));
    }

    it("high-volume, sparse term → below minRatio → NOT superior", () => {
      // 2 of 100 bodies mention the term (0.02) — a busy telemetry day.
      const report = scoreWithRules({
        rubric: kwRubric(0.15),
        usageRows: [],
        bodyRows: bodies(2, 100),
      });
      expect(report.totalScore).toBe(100); // standard, not saturated to 120
    });

    it("dense term above minRatio → superior", () => {
      // 30 of 100 bodies (0.30) genuinely show the language.
      const report = scoreWithRules({
        rubric: kwRubric(0.15),
        usageRows: [],
        bodyRows: bodies(30, 100),
      });
      expect(report.totalScore).toBe(120);
    });

    it("without minRatio, a single hit still wins (legacy any-hit preserved)", () => {
      const report = scoreWithRules({
        rubric: kwRubric(undefined),
        usageRows: [],
        bodyRows: bodies(1, 100),
      });
      expect(report.totalScore).toBe(120);
    });
  });

  // ── Plan 4C facet-based signals ────────────────────────────────────────
  describe("facet signals", () => {
    function mkFacetSection(
      signal: Rubric["sections"][number]["signals"][number],
    ): Rubric["sections"][number] {
      return {
        id: "facet-section",
        name: "Facet",
        weight: "100%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [signal],
      };
    }

    it("facet_claude_helpfulness hits when mean >= gte across facet rows", () => {
      const rubric = mkRubric([
        mkFacetSection({
          type: "facet_claude_helpfulness",
          id: "fch",
          gte: 4,
        }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: 5,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: 4,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
        ],
      });
      // mean 4.5 >= 4 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet_friction_per_session is inverted: hit when mean <= lte", () => {
      const rubric = mkRubric([
        mkFacetSection({
          type: "facet_friction_per_session",
          id: "ffps",
          lte: 1,
        }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: 0,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: 1,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
        ],
      });
      // mean 0.5 <= 1 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet_bugs_caught hits when sum >= gte", () => {
      const rubric = mkRubric([
        mkFacetSection({ type: "facet_bugs_caught", id: "fbc", gte: 3 }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: 2,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: 2,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
        ],
      });
      // sum 4 >= 3 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet_codex_errors is inverted: hit when sum <= lte", () => {
      const rubric = mkRubric([
        mkFacetSection({ type: "facet_codex_errors", id: "fce", lte: 5 }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: 2,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: 1,
            userSatisfaction: null,
          },
        ],
      });
      // sum 3 <= 5 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet_outcome_success_rate hits when (success+partial)/total >= gte", () => {
      const rubric = mkRubric([
        mkFacetSection({
          type: "facet_outcome_success_rate",
          id: "fosr",
          gte: 0.5,
        }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: null,
            outcome: "success",
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: "partial",
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: null,
            outcome: "failure",
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
        ],
      });
      // 2/3 >= 0.5 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet_session_type_ratio counts only the targetType against total", () => {
      const rubric = mkRubric([
        mkFacetSection({
          type: "facet_session_type_ratio",
          id: "fstr",
          targetType: "feature_dev",
          gte: 0.5,
        }),
      ]);
      const report = scoreWithRules({
        rubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [
          {
            sessionType: "feature_dev",
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: "feature_dev",
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
          {
            sessionType: "bug_fix",
            outcome: null,
            claudeHelpfulness: null,
            frictionCount: null,
            bugsCaughtCount: null,
            codexErrorsCount: null,
            userSatisfaction: null,
          },
        ],
      });
      // 2/3 ≈ 0.67 >= 0.5 → superior
      expect(report.totalScore).toBe(120);
    });

    it("facet signals degrade gracefully when no facet rows are present", () => {
      // gte aggregator → hit:false → standard
      const rubricGte = mkRubric([
        mkFacetSection({ type: "facet_bugs_caught", id: "fbc", gte: 1 }),
      ]);
      const reportGte = scoreWithRules({
        rubric: rubricGte,
        usageRows: [],
        bodyRows: [],
      });
      expect(reportGte.totalScore).toBe(100);

      // lte (inverted) aggregator → hit:true → superior
      const rubricLte = mkRubric([
        mkFacetSection({
          type: "facet_friction_per_session",
          id: "ffps",
          lte: 1,
        }),
      ]);
      const reportLte = scoreWithRules({
        rubric: rubricLte,
        usageRows: [],
        bodyRows: [],
      });
      expect(reportLte.totalScore).toBe(120);
    });
  });

  // ── Rubric v2 — continuous scoring integration ──────────────────────────
  const contRubric = {
    name: "v2",
    version: "2.0.0",
    locale: "en" as const,
    scale: { max: 120, pass: 108 },
    sections: [
      {
        id: "sat",
        name: "Satisfaction",
        weight: "100%",
        scoring: { mode: "continuous" as const },
        minSamples: 2,
        signals: [
          {
            type: "facet_user_satisfaction" as const,
            id: "usat",
            gte: 3.5,
            points: 100,
            curve: { zeroAt: 2.5, fullAt: 4.5 },
          },
        ],
      },
    ],
  };

  const facetRow = (userSatisfaction: number | null) => ({
    sessionType: null, outcome: null, claudeHelpfulness: null,
    frictionCount: null, bugsCaughtCount: null, codexErrorsCount: null,
    userSatisfaction,
  });

  describe("scoreWithRules v2 continuous", () => {
    it("scores a continuous rubric from facet rows on the 120 scale", () => {
      const report = scoreWithRules({
        rubric: contRubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [facetRow(4.5), facetRow(4.5), facetRow(4.5)],
      });
      expect(report.totalScore).toBeCloseTo(120);
      expect(report.insufficientData).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(report.sectionScores[0]!.mode).toBe("continuous");
    });

    it("yields a mid-scale score for mid-scale inputs (no more all-or-nothing)", () => {
      const report = scoreWithRules({
        rubric: contRubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [facetRow(3.5), facetRow(3.5)],
      });
      expect(report.totalScore).toBeCloseTo(60); // subscore 0.5 → 120×0.5
    });

    it("returns null totalScore + insufficientData when samples are too thin", () => {
      const report = scoreWithRules({
        rubric: contRubric,
        usageRows: [],
        bodyRows: [],
        facetRows: [facetRow(5)], // 1 < minSamples 2
      });
      expect(report.totalScore).toBeNull();
      expect(report.insufficientData).toBe(true);
    });

    it("keeps legacy tiered rubrics working (insufficientData always false)", () => {
      const tieredRubric = {
        name: "v1", version: "1.0.0", locale: "en" as const,
        sections: [{
          id: "risk", name: "Risk", weight: "100%",
          standard: { score: 100, label: "Std", criteria: [] },
          superior: { score: 120, label: "Sup", criteria: [] },
          signals: [{ type: "refusal_rate" as const, id: "rr", lte: 0.2 }],
        }],
      };
      const report = scoreWithRules({ rubric: tieredRubric, usageRows: [], bodyRows: [] });
      expect(report.totalScore).toBe(120); // 空 bodies → refusal hit:true → 全 signal 命中 → superior（既有 v1 行為）
      expect(report.insufficientData).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(report.sectionScores[0]!.mode).toBe("tiered");
    });
  });

  describe("keyword v2 — latest-human-turn scanning", () => {
    const kwRubric = {
      name: "kw", version: "1.0.0", locale: "en" as const,
      sections: [{
        id: "s", name: "S", weight: "100%",
        standard: { score: 100, label: "Std", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [{
          type: "keyword" as const, id: "kw", in: "request_body" as const,
          terms: ["refactor"], caseSensitive: false, minRatio: 0.5,
        }],
      }],
    };

    const bodyWith = (requestId: string, messages: unknown[]) => ({
      requestId, stopReason: null, clientUserAgent: null, clientSessionId: null,
      requestParams: null, responseBody: null, requestBody: { messages },
    });

    it("history mentions no longer snowball into later turns", () => {
      // 3 個 body 共用同一段含 "refactor" 的歷史，但只有第 1 個的「最新 user turn」提到 refactor
      const history = [
        { role: "user", content: [{ type: "text", text: "refactor this" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
      const bodies = [
        bodyWith("r1", [{ role: "user", content: [{ type: "text", text: "refactor this" }] }]),
        bodyWith("r2", [...history, { role: "user", content: [{ type: "text", text: "add tests" }] }]),
        bodyWith("r3", [...history, { role: "user", content: [{ type: "text", text: "ship it" }] }]),
      ];
      const report = scoreWithRules({ rubric: kwRubric, usageRows: [], bodyRows: bodies });
      // 1/3 < 0.5 → 不 hit → section 停在 standard
      expect(report.sectionScores[0]!.signals[0]!.hit).toBe(false);
    });

    it("pure tool_result turns are excluded from the minRatio denominator", () => {
      const bodies = [
        bodyWith("r1", [{ role: "user", content: [{ type: "text", text: "please refactor" }] }]),
        bodyWith("r2", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "refactor refactor" }] }]),
      ];
      const report = scoreWithRules({ rubric: kwRubric, usageRows: [], bodyRows: bodies });
      // 分母 1（r2 無真人文字）→ 1/1 >= 0.5 → hit
      expect(report.sectionScores[0]!.signals[0]!.hit).toBe(true);
    });
  });
});
