import { describe, it, expect } from "vitest";
import {
  truncateDiff,
  DIFF_MAX_TOTAL_CHARS,
  DIFF_MAX_FILE_CHARS,
} from "../../src/delivery/truncateDiff";

// Trailing "\n" matters: real diff sections always end on a newline, and
// consecutive fileSection() outputs must each start "diff --git " at the
// beginning of a line for the /^diff --git /m boundary to split them.
const fileSection = (name: string, bodyChars: number): string =>
  `diff --git a/${name} b/${name}\n` + "+".repeat(bodyChars) + "\n";

describe("truncateDiff", () => {
  it("passes through byte-identical when under both caps", () => {
    const diff = fileSection("a.ts", 100) + fileSection("b.ts", 100);
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("returns empty string for empty input", () => {
    expect(truncateDiff("")).toBe("");
  });

  it("never throws on arbitrary non-diff text", () => {
    expect(() => truncateDiff("not a diff at all, just prose\nmore text")).not.toThrow();
    expect(truncateDiff("not a diff at all, just prose\nmore text")).toBe(
      "not a diff at all, just prose\nmore text",
    );
  });

  it("caps an oversize first file section with a truncation marker, leaves an intact second section untouched", () => {
    const maxFileChars = 50;
    const first = fileSection("big.ts", 500); // way over maxFileChars
    const second = fileSection("small.ts", 5); // under maxFileChars
    const diff = first + second;

    const out = truncateDiff(diff, { maxFileChars, maxTotalChars: 10_000 });

    // second section is fully intact and present verbatim
    expect(out).toContain(second);
    // first section got cut down to at most maxFileChars original chars + marker
    expect(out).toContain("\n…[truncated]\n");
    const truncatedFirstIndex = out.indexOf("…[truncated]");
    const secondIndex = out.indexOf(second);
    expect(truncatedFirstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(truncatedFirstIndex);
    // the raw (pre-marker) slice of the first section must not exceed maxFileChars
    const firstSectionOut = out.slice(0, out.indexOf(second));
    const rawPortion = firstSectionOut.replace("\n…[truncated]\n", "");
    expect(rawPortion.length).toBeLessThanOrEqual(maxFileChars);
  });

  it("stops concatenation before exceeding maxTotalChars and appends a files-truncated marker naming the right N", () => {
    // 10 small files, each well under the per-file cap, but together over a small total cap.
    const maxFileChars = 1_000;
    const maxTotalChars = 250;
    const sections = Array.from({ length: 10 }, (_, i) => fileSection(`f${i}.ts`, 40));
    const diff = sections.join("");

    const out = truncateDiff(diff, { maxFileChars, maxTotalChars });

    expect(out).toMatch(/\n…\[\d+ more files truncated\]$/);
    const match = out.match(/\n…\[(\d+) more files truncated\]$/);
    expect(match).not.toBeNull();
    const remainingCount = Number(match![1]);

    // Count how many whole sections actually made it into the output
    // (before the trailing marker).
    const bodyWithoutMarker = out.slice(0, out.length - match![0].length);
    const includedCount = sections.filter((s) => bodyWithoutMarker.includes(s)).length;
    expect(includedCount + remainingCount).toBe(sections.length);
    expect(includedCount).toBeLessThan(sections.length);
    expect(includedCount).toBeGreaterThan(0);

    // The concatenated body (sans trailing marker) never exceeds the total cap.
    expect(bodyWithoutMarker.length).toBeLessThanOrEqual(maxTotalChars);
  });

  it("treats content before the first 'diff --git' line as its own (preamble) section", () => {
    const preamble = "commit abcdef\nAuthor: x\n\n";
    const diff = preamble + fileSection("a.ts", 20);
    const out = truncateDiff(diff);
    expect(out).toBe(diff);
  });

  it("uses default DIFF_MAX_TOTAL_CHARS / DIFF_MAX_FILE_CHARS when opts are omitted", () => {
    expect(DIFF_MAX_TOTAL_CHARS).toBe(30_000);
    expect(DIFF_MAX_FILE_CHARS).toBe(4_000);
    // A single file just at the default per-file cap passes through untouched.
    const prefixLen = "diff --git a/exact.ts b/exact.ts\n".length;
    const trailingNewlineLen = 1;
    const diff = fileSection("exact.ts", DIFF_MAX_FILE_CHARS - prefixLen - trailingNewlineLen);
    expect(diff.length).toBe(DIFF_MAX_FILE_CHARS);
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("custom opts override the defaults", () => {
    const diff = fileSection("a.ts", 200);
    const out = truncateDiff(diff, { maxFileChars: 30 });
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThan(diff.length);
  });

  it("never emits a lone surrogate when the per-file cap bisects an emoji", () => {
    // "😀" is a surrogate pair (2 code units). Placing it so maxFileChars
    // lands between its halves is the emoji-at-the-boundary case: a naive
    // slice would leave a trailing lone high surrogate in the prompt,
    // risking an upstream 400 that burns all three BullMQ retries on an
    // identical payload — the diff is the biggest text in the prompt (30k
    // chars vs. the 4k/1k/300 caps qualityPrompt.ts's capText guards), so
    // this is the highest-yield place for that boundary to be hit for real.
    const maxFileChars = 40;
    const prefix = "diff --git a/x b/x\n";
    const body = "+".repeat(maxFileChars - prefix.length - 1) + "😀" + "tail";
    const diff = prefix + body;

    const out = truncateDiff(diff, { maxFileChars, maxTotalChars: 10_000 });

    // Every surrogate code unit left in the output must be part of a valid pair.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(out)).toBe(false);
    expect(out).toContain("…[truncated]");
  });
});
