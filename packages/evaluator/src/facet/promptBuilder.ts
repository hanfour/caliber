export const CURRENT_PROMPT_VERSION = 2;

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface FacetPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

const SYSTEM_PROMPT = `You are an evaluator analysing a single Claude Code session. Given the transcript, classify it against the schema below. Output JSON only, no prose, no markdown.

Schema:
{
  "sessionType": "feature_dev" | "bug_fix" | "refactor" | "exploration" | "other",
  "outcome":     "success" | "partial" | "failure" | "abandoned",
  "claudeHelpfulness": 1 | 2 | 3 | 4 | 5,
  "frictionCount":     non-negative integer,
  "bugsCaughtCount":   non-negative integer,
  "codexErrorsCount":  non-negative integer,
  "userSatisfaction":  1 | 2 | 3 | 4 | 5
}

Definitions:
- frictionCount: user-visible pain points (misunderstanding, rework, confusion)
- bugsCaughtCount: defects Claude identified in user's code
- codexErrorsCount: tool/parse errors from Claude's own output
- userSatisfaction: how satisfied the user appears with the final outcome,
  judged from closing tone and whether they accepted/used the result
  (5 = explicit satisfaction or silent acceptance and moving on;
   1 = explicit frustration or abandoning the approach)

Examples:
Example 1 (feature_dev success):
{"sessionType":"feature_dev","outcome":"success","claudeHelpfulness":5,"frictionCount":0,"bugsCaughtCount":1,"codexErrorsCount":0,"userSatisfaction":5}

Example 2 (bug_fix failure):
{"sessionType":"bug_fix","outcome":"failure","claudeHelpfulness":2,"frictionCount":3,"bugsCaughtCount":0,"codexErrorsCount":2,"userSatisfaction":2}

Example 3 (exploration abandoned):
{"sessionType":"exploration","outcome":"abandoned","claudeHelpfulness":3,"frictionCount":1,"bugsCaughtCount":0,"codexErrorsCount":0,"userSatisfaction":3}`;

function approxTokens(s: string): number {
  // ~4 chars per token rule of thumb for English/code mix
  return Math.ceil(s.length / 4);
}

const DEFAULT_USER_TOKEN_BUDGET = 8000;

export interface TruncateResult {
  turns: Turn[];
  truncated: boolean;
}

export function truncateTurns(
  turns: Turn[],
  maxTokens: number = DEFAULT_USER_TOKEN_BUDGET,
): TruncateResult {
  const total = turns.reduce((acc, t) => acc + approxTokens(t.content), 0);
  if (total <= maxTokens) return { turns, truncated: false };

  const headBudget = Math.floor(maxTokens * 0.4);
  const tailBudget = Math.floor(maxTokens * 0.4);

  const head: Turn[] = [];
  let usedHead = 0;
  for (const t of turns) {
    const tk = approxTokens(t.content);
    if (usedHead + tk > headBudget) break;
    head.push(t);
    usedHead += tk;
  }

  const tail: Turn[] = [];
  let usedTail = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t) continue;
    const tk = approxTokens(t.content);
    if (usedTail + tk > tailBudget) break;
    tail.unshift(t);
    usedTail += tk;
  }

  // Drop any overlap (small head or small tail could otherwise duplicate).
  const headEnd = head.length;
  const tailStart = turns.length - tail.length;
  const tailNonOverlapping =
    tailStart >= headEnd ? tail : tail.slice(headEnd - tailStart);

  const skippedTurns = turns.length - head.length - tailNonOverlapping.length;
  const skippedTokens =
    total -
    usedHead -
    tailNonOverlapping.reduce((a, t) => a + approxTokens(t.content), 0);

  if (skippedTurns <= 0) {
    return { turns: [...head, ...tailNonOverlapping], truncated: false };
  }

  const placeholder: Turn = {
    role: "user",
    content: `[... ${skippedTurns} turns / ~${skippedTokens} tokens truncated ...]`,
  };

  return {
    turns: [...head, placeholder, ...tailNonOverlapping],
    truncated: true,
  };
}

export function buildFacetPrompt({ turns }: { turns: Turn[] }): FacetPrompt {
  const { turns: trimmed } = truncateTurns(turns, DEFAULT_USER_TOKEN_BUDGET);
  const user = trimmed.map((t) => `${t.role}: ${t.content}`).join("\n\n");
  return {
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 256, // JSON output is small
  };
}
