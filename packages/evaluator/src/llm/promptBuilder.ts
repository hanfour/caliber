import type { BuildPromptInput, LlmPrompt, Snippet } from "./types.js";

const SYSTEM_PROMPT = [
  "You are evaluating a software engineer's AI-assisted development quality",
  "based on captured conversation snippets and rule-based signals.",
  "Use the provided rubric verbatim for scoring criteria.",
  "Produce two audience-specific reports from the same facts.",
  "The user report must be constructive, actionable, and written directly to the engineer.",
  "The admin report may be more diagnostic, but must not infer personality, health, intent, or protected traits, and must not recommend employment actions.",
  "Your response MUST be valid JSON matching the schema described in the user message.",
  "Do not include commentary outside the JSON object.",
].join(" ");

export function buildPrompt(input: BuildPromptInput): LlmPrompt {
  const { rubric, ruleBasedReport, snippets } = input;

  const rubricSection = `# Rubric\n\n\`\`\`json\n${JSON.stringify(rubric, null, 2)}\n\`\`\``;

  const ruleBasedSummary = {
    totalScore: ruleBasedReport.totalScore,
    sectionScores: ruleBasedReport.sectionScores.map((s) => ({
      sectionId: s.sectionId,
      score: s.score,
      label: s.label,
      signals: s.signals.map((h) => ({ id: h.id, hit: h.hit, value: h.value })),
    })),
    signalsSummary: ruleBasedReport.signalsSummary,
    dataQuality: ruleBasedReport.dataQuality,
  };

  const signalsSection =
    `# Rule-based signals already computed\n\n\`\`\`json\n` +
    `${JSON.stringify(ruleBasedSummary, null, 2)}\n\`\`\``;

  const snippetsSection = [
    `# Conversation snippets (${snippets.length} of up to 20, reason-tagged)`,
    "",
    ...snippets.map(formatSnippet),
  ].join("\n");

  const responseSchema = [
    "# Required response schema",
    "",
    "```json",
    `{
  "userReport": {
    "title": "string",
    "summary": "2 concise paragraphs grounded in the rubric",
    "strengths": [{ "sectionId": "string", "title": "string", "detail": "string" }],
    "growthAreas": [{ "sectionId": "string", "title": "string", "detail": "string", "action": "string" }],
    "nextSteps": [{ "sectionId": "string (optional)", "title": "string", "rationale": "string", "priority": "high|medium|low" }]
  },
  "adminReport": {
    "title": "string",
    "executiveSummary": "concise management summary",
    "performanceAssessment": "deeper rubric-based assessment",
    "strengths": [{ "sectionId": "string", "title": "string", "detail": "string" }],
    "concerns": [{ "sectionId": "string", "title": "string", "detail": "string", "severity": "high|medium|low", "evidenceRequestIds": ["string"] }],
    "coachingPlan": [{ "sectionId": "string (optional)", "title": "string", "rationale": "string", "priority": "high|medium|low", "successMeasure": "string" }],
    "calibrationNotes": ["string"],
    "dataLimitations": ["string"]
  },
  "evidence": [{ "quote": "string", "requestId": "string", "rationale": "string" }],
  "sectionAdjustments": [{ "sectionId": "string", "adjustment": 0, "rationale": "string" }]
}`,
    "```",
    "",
    "Use only sectionId values present in the rubric.",
    "The userReport must not contain request IDs, raw quotes, model/account cost, organization comparisons, or internal operational diagnostics.",
    "The adminReport may reference request IDs only in concerns.evidenceRequestIds; put raw quotes only in the top-level evidence array.",
    "When data coverage is weak, say so in adminReport.dataLimitations and avoid strong conclusions.",
    "Write both reports in the rubric locale.",
    "Adjustments nudge rule-based scores (±10), never replace them. Cite evidence with requestIds.",
  ].join("\n");

  const userContent = [
    rubricSection,
    "",
    signalsSection,
    "",
    snippetsSection,
    "",
    responseSchema,
  ].join("\n");

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  };
}

function formatSnippet(s: Snippet): string {
  const sessionPart = s.clientSessionId ? ` — session: ${s.clientSessionId}` : "";
  return [
    `## ${s.requestId} — reason: ${s.reason}${sessionPart}`,
    "",
    "### Request",
    "```",
    s.requestExcerpt,
    "```",
    "",
    "### Response",
    "```",
    s.responseExcerpt,
    "```",
    "",
  ].join("\n");
}
