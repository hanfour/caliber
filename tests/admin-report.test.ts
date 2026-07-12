import { describe, expect, it } from "vitest";
import { renderAdminMarkdown, type LocalAdminReport } from "../src/admin-report.js";

describe("admin report rendering", () => {
  it("marks local scoring and includes admin calibration sections", () => {
    const report: LocalAdminReport = {
      generatedAt: "2026-07-12T00:00:00.000Z",
      scoredLocally: true,
      org: { id: "org", slug: "onead", name: "OneAD" },
      member: { id: "member", email: "dev@example.com", name: "Dev" },
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-13T00:00:00.000Z" },
      rubric: { id: "rubric", version: "1", source: "org", name: "Engineering" },
      source: { session_count: 2, event_count: 12, turn_count: 4 },
      result: {
        totalScore: 80,
        sectionScores: [{
          sectionId: "quality",
          name: "Quality",
          weight: 100,
          standardScore: 80,
          superiorScore: 120,
          score: 80,
          label: "Standard",
          signals: [{ id: "tests", type: "keyword", hit: false, evidence: [] }],
        }],
        signalsSummary: {
          requests: 4,
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost: 0,
          cache_read_ratio: 0,
          model_diversity: 1,
          client_mix_ratio: 1,
          refusal_rate: 0,
          body_capture_coverage: 1,
          tool_diversity: 0,
          iteration_count: 1,
        },
        dataQuality: { capturedRequests: 4, missingBodies: 0, truncatedBodies: 0, totalRequests: 4, coverageRatio: 1 },
      },
    };
    const markdown = renderAdminMarkdown(report);
    expect(markdown).toContain("Scoring execution: local CLI");
    expect(markdown).toContain("## Concerns And Calibration");
    expect(markdown).toContain("## Coaching Plan");
    expect(markdown).toContain("tests");
  });
});
