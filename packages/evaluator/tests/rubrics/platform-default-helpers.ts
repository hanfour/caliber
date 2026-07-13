import { rubricSchema, scoreWithRules } from "../../src";
import type { UsageRow, BodyRow } from "../../src";

/**
 * Asserts that a rubric JSON conforms to the platform-default structure:
 * 2 sections, 6 signals (3 per section), correct superiorRules, weights summing to 100%.
 *
 * Returns the parsed rubric for further assertions.
 */
export function assertPlatformDefaultStructure(rubricJson: unknown) {
  const r = rubricSchema.parse(rubricJson);

  const total = r.sections.reduce(
    (acc, s) => acc + Number(s.weight.replace("%", "")),
    0,
  );
  if (total !== 100) {
    throw new Error(`Expected weights to sum to 100, got ${total}`);
  }

  if (r.sections.length !== 2) {
    throw new Error(`Expected 2 sections, got ${r.sections.length}`);
  }

  const interaction = r.sections.find((s) => s.id === "interaction");
  if (!interaction) throw new Error("Missing 'interaction' section");
  const interactionIds = interaction.signals.map((s) => s.id).sort();
  const expectedInteractionIds = [
    "interaction_keywords",
    "iterative_exploration",
    "multi_tool_usage",
  ];
  if (JSON.stringify(interactionIds) !== JSON.stringify(expectedInteractionIds)) {
    throw new Error(
      `Unexpected interaction signal IDs: ${JSON.stringify(interactionIds)}`,
    );
  }

  const riskControl = r.sections.find((s) => s.id === "riskControl");
  if (!riskControl) throw new Error("Missing 'riskControl' section");
  const riskIds = riskControl.signals.map((s) => s.id).sort();
  const expectedRiskIds = [
    "low_refusal_rate",
    "performance_keywords",
    "security_keywords",
  ];
  if (JSON.stringify(riskIds) !== JSON.stringify(expectedRiskIds)) {
    throw new Error(`Unexpected riskControl signal IDs: ${JSON.stringify(riskIds)}`);
  }

  // Verify superiorRules are present on each section
  if (!interaction.superiorRules) throw new Error("interaction missing superiorRules");
  if (!riskControl.superiorRules) throw new Error("riskControl missing superiorRules");

  return r;
}

/**
 * Standard scoring fixture — no signals fire → totalScore should be 100.
 */
export function scoreStandard(rubricJson: unknown): number {
  const r = rubricSchema.parse(rubricJson);
  const report = scoreWithRules({ rubric: r, usageRows: [], bodyRows: [] });
  if (report.totalScore === null) {
    throw new Error(
      "expected legacy tiered rubric to produce a numeric totalScore, got insufficientData",
    );
  }
  return report.totalScore;
}

/**
 * Superior scoring fixture — all strong signals fire → totalScore >= 110.
 * This exercises the same data path as the en rubric's superior test.
 */
export function scoreSuperior(rubricJson: unknown): number {
  const r = rubricSchema.parse(rubricJson);

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
  ];

  const bodies: BodyRow[] = [
    {
      requestId: "r1",
      stopReason: "end_turn",
      clientUserAgent: null,
      clientSessionId: "s1",
      requestParams: null,
      requestBody: {
        messages: [
          { role: "user", content: "let's refactor this" },
          { role: "assistant", content: "sure" },
          { role: "user", content: "another approach" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "iterate" },
          { role: "assistant", content: "done" },
        ],
      },
      responseBody: {
        content: [
          { type: "text", text: "let's review security and performance" },
          { type: "tool_use", name: "read", input: {} },
          { type: "tool_use", name: "bash", input: {} },
          { type: "tool_use", name: "grep", input: {} },
        ],
      },
    },
  ];

  const report = scoreWithRules({ rubric: r, usageRows: usage, bodyRows: bodies });
  if (report.totalScore === null) {
    throw new Error(
      "expected legacy tiered rubric to produce a numeric totalScore, got insufficientData",
    );
  }
  return report.totalScore;
}
