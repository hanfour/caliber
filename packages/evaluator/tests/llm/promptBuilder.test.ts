import { describe, it, expect } from "vitest";
import { buildPrompt } from "../../src/llm/promptBuilder";
import type { BuildPromptInput, Snippet } from "../../src/llm/types";
import type { Rubric } from "../../src/rubric/schema";
import type { Report } from "../../src/engine/types";

function mkRubric(): Rubric {
  return {
    name: "Test Rubric",
    version: "1.0.0",
    locale: "en",
    sections: [
      {
        id: "sec1",
        name: "Code Quality",
        weight: "100%",
        standard: {
          score: 100,
          label: "Standard",
          criteria: ["Uses AI effectively"],
        },
        superior: {
          score: 120,
          label: "Superior",
          criteria: ["Demonstrates mastery"],
        },
        signals: [{ type: "cache_read_ratio", id: "cr1", gte: 0.5 }],
      },
    ],
  };
}

function mkReport(): Report {
  return {
    totalScore: 100,
    sectionScores: [
      {
        sectionId: "sec1",
        name: "Code Quality",
        weight: 100,
        standardScore: 100,
        superiorScore: 120,
        score: 100,
        label: "Standard",
        signals: [
          { id: "cr1", type: "cache_read_ratio", hit: false, value: 0.2 },
        ],
      },
    ],
    signalsSummary: {
      requests: 5,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200,
      cache_creation_tokens: 100,
      total_cost: 0.05,
      cache_read_ratio: 0.2,
      refusal_rate: 0,
      model_mix: { "claude-sonnet-4": 5 },
      client_mix: { "claude-code": 5 },
      model_diversity: 1,
      tool_diversity: 0,
      iteration_count: 3,
      client_mix_ratio: 1,
      body_capture_coverage: 1,
      period: { requestCount: 5, bodyCount: 5 },
    },
    dataQuality: {
      capturedRequests: 5,
      missingBodies: 0,
      truncatedBodies: 0,
      totalRequests: 5,
      coverageRatio: 1,
    },
  };
}

function mkSnippet(requestId: string): Snippet {
  return {
    requestId,
    clientSessionId: "sessionA",
    capturedAt: "2026-04-22T12:00:00Z",
    reason: "random",
    requestExcerpt: `Request for ${requestId}`,
    responseExcerpt: `Response for ${requestId}`,
  };
}

describe("buildPrompt", () => {
  it("returns correct { system, messages } shape with one user message", () => {
    const input: BuildPromptInput = {
      rubric: mkRubric(),
      ruleBasedReport: mkReport(),
      snippets: [],
    };
    const result = buildPrompt(input);
    expect(result).toHaveProperty("system");
    expect(result).toHaveProperty("messages");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(typeof result.messages[0]?.content).toBe("string");
  });

  it("system message references rubric compliance / evaluation purpose", () => {
    const input: BuildPromptInput = {
      rubric: mkRubric(),
      ruleBasedReport: mkReport(),
      snippets: [],
    };
    const { system } = buildPrompt(input);
    expect(system.toLowerCase()).toContain("rubric");
    expect(system.toLowerCase()).toContain("evaluat");
    expect(system).toContain("user report");
    expect(system).toContain("admin report");
  });

  it("user message contains the rubric JSON", () => {
    const rubric = mkRubric();
    const input: BuildPromptInput = {
      rubric,
      ruleBasedReport: mkReport(),
      snippets: [],
    };
    const { messages } = buildPrompt(input);
    const content = messages[0]!.content;
    expect(content).toContain("Test Rubric");
    expect(content).toContain("Code Quality");
  });

  it("user message contains rule-based signals summary", () => {
    const input: BuildPromptInput = {
      rubric: mkRubric(),
      ruleBasedReport: mkReport(),
      snippets: [],
    };
    const { messages } = buildPrompt(input);
    const content = messages[0]!.content;
    expect(content).toContain("totalScore");
    expect(content).toContain("sectionScores");
    expect(content).toContain("dataQuality");
    expect(content).toContain('"userReport"');
    expect(content).toContain('"adminReport"');
    expect(content).toContain("must not contain request IDs");
  });

  it("user message contains all provided snippets", () => {
    const snippets = [
      mkSnippet("req-1"),
      mkSnippet("req-2"),
      mkSnippet("req-3"),
    ];
    const input: BuildPromptInput = {
      rubric: mkRubric(),
      ruleBasedReport: mkReport(),
      snippets,
    };
    const { messages } = buildPrompt(input);
    const content = messages[0]!.content;
    for (const snippet of snippets) {
      expect(content).toContain(snippet.requestId);
      expect(content).toContain(snippet.requestExcerpt);
      expect(content).toContain(snippet.responseExcerpt);
    }
  });
});
