/**
 * Pure prompt builder for the LLM delivery-quality layer (PR3 Task 4).
 * No I/O — assembles the system/user message pair sent to the facet LLM.
 * The system message pins a strict JSON-only output contract so the
 * companion parser (qualityParser.ts) can coerce the reply reliably.
 */

export interface QualityPromptPr {
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  diff: string;
  reviewComments: string[];
}

export interface QualityPromptSectionScore {
  key: string;
  score: number | null;
}

export interface BuildDeliveryQualityPromptInput {
  windowDays: number;
  quantTotal: number;
  sectionSummary: QualityPromptSectionScore[];
  prs: QualityPromptPr[];
}

export interface DeliveryQualityPrompt {
  system: string;
  user: string;
}

const MAX_REVIEW_COMMENTS = 20;

const SYSTEM_PROMPT = [
  "You are a senior engineer assessing the delivery quality of a teammate's recent merged pull requests, based on the real PR titles, descriptions, review comments, and diffs provided in the user message.",
  "You MUST reply with ONLY a single JSON object, and nothing else, matching exactly this shape:",
  '{"qualityAdjustment": <number in the range -15 to 15>, "narrative": "<string, written in 繁體中文台灣用語 (Traditional Chinese, Taiwan Mandarin, zh-TW), 3 to 6 sentences>", "evidence": [{"repo": "<string>", "prNumber": <number>, "quote": "<string>", "reason": "<string>"}]}',
  "qualityAdjustment MUST be a number between -15 and 15 inclusive — it nudges the quantitative delivery score, it does not replace it.",
  "narrative MUST be 繁體中文台灣用語 (zh-TW), 3 to 6 sentences.",
  "evidence MUST contain 1 to 5 items; each quote MUST be copied verbatim (character-for-character) from the diff or comments below, and MUST be at most 200 characters.",
  "Do not wrap the JSON in markdown code fences. Do not include any prose, explanation, or commentary outside the JSON object — reply with ONLY the JSON object.",
].join(" ");

export const QUALITY_RETRY_SUFFIX =
  "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object — no fences, no commentary.";

export function buildDeliveryQualityPrompt(
  input: BuildDeliveryQualityPromptInput,
): DeliveryQualityPrompt {
  const { windowDays, quantTotal, sectionSummary, prs } = input;

  const quantSection = [
    "# Quantitative context",
    "",
    `Window: ${windowDays} days`,
    `Quantitative delivery score: ${quantTotal}`,
    "Section scores:",
    ...sectionSummary.map((s) => `- ${s.key}: ${s.score === null ? "N/A" : s.score}`),
  ].join("\n");

  const prsSection = [
    `# Sampled pull requests (${prs.length})`,
    "",
    prs.map(formatPr).join("\n\n"),
  ].join("\n");

  const user = [quantSection, "", prsSection].join("\n");

  return { system: SYSTEM_PROMPT, user };
}

function formatPr(pr: QualityPromptPr): string {
  const comments = pr.reviewComments.slice(0, MAX_REVIEW_COMMENTS);
  return [
    `## ${pr.repoFullName}#${pr.number} — ${pr.title}`,
    "",
    "### Description",
    pr.body ?? "(no description)",
    "",
    `### Review comments (${comments.length})`,
    ...(comments.length > 0 ? comments.map((c) => `- ${c}`) : ["(none)"]),
    "",
    "### Diff",
    "```diff",
    pr.diff,
    "```",
  ].join("\n");
}
