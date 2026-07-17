/**
 * Pure diff truncation for the LLM quality layer (PR3 spec 2026-07-15).
 * No I/O, no mutation — just budgets an arbitrary diff string down to a
 * size that's safe to hand to an LLM prompt. Never throws: arbitrary
 * (even non-diff) text is treated as a single section and passed through
 * unless it exceeds the caps.
 */

export const DIFF_MAX_TOTAL_CHARS = 30_000;
export const DIFF_MAX_FILE_CHARS = 4_000;

export interface TruncateDiffOptions {
  maxTotalChars?: number;
  maxFileChars?: number;
}

const FILE_TRUNCATED_MARKER = "\n…[truncated]\n";

// Splits on "diff --git " line boundaries, keeping the delimiter with the
// section that follows it. Content before the first such boundary (a rare
// preamble, e.g. from `git format-patch`-style output) forms its own
// leading section.
const FILE_BOUNDARY = /(?=^diff --git )/m;

function capFileSection(section: string, maxFileChars: number): string {
  if (section.length <= maxFileChars) return section;
  return section.slice(0, maxFileChars) + FILE_TRUNCATED_MARKER;
}

export function truncateDiff(diff: string, opts: TruncateDiffOptions = {}): string {
  if (diff === "") return "";

  const maxTotalChars = opts.maxTotalChars ?? DIFF_MAX_TOTAL_CHARS;
  const maxFileChars = opts.maxFileChars ?? DIFF_MAX_FILE_CHARS;

  const sections = diff
    .split(FILE_BOUNDARY)
    .map((section) => capFileSection(section, maxFileChars));

  let out = "";
  let includedCount = 0;
  for (const section of sections) {
    if (out.length + section.length > maxTotalChars) break;
    out += section;
    includedCount++;
  }

  const remaining = sections.length - includedCount;
  if (remaining > 0) {
    out += `\n…[${remaining} more files truncated]`;
  }

  return out;
}
