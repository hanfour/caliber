/**
 * Minimal line-level diff for the replay comparison page.
 *
 * Two model outputs almost always differ somewhere; the operator's question is
 * *where*. Aligning by index would answer that wrongly the moment one side
 * gains or loses a line (everything after would read as changed), so this uses
 * a real LCS alignment.
 *
 * `MAX_LINES` is a hard stop rather than a tuning knob: the DP table is
 * O(left × right) and captured bodies run up to 256KB, which would freeze the
 * tab. Past the cap the caller renders both sides plain and says so — no
 * markers at all is honest; markers computed from a truncated comparison would
 * not be.
 */

export type DiffOp = "same" | "changed";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface LineDiff {
  left: DiffLine[];
  right: DiffLine[];
  /** False when the inputs were too large to align; both sides are `same`. */
  computed: boolean;
}

export const MAX_DIFF_LINES = 400;

function plain(lines: string[]): DiffLine[] {
  return lines.map((text) => ({ op: "same" as const, text }));
}

export function lineDiff(leftText: string, rightText: string): LineDiff {
  const left = leftText.split("\n");
  const right = rightText.split("\n");

  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return { left: plain(left), right: plain(right), computed: false };
  }

  const n = left.length;
  const m = right.length;

  // lcs[i][j] = length of the longest common subsequence of left[i…] / right[j…]
  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] =
        left[i] === right[j]
          ? lcs[at(i + 1, j + 1)]! + 1
          : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
    }
  }

  const outLeft: DiffLine[] = [];
  const outRight: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      outLeft.push({ op: "same", text: left[i]! });
      outRight.push({ op: "same", text: right[j]! });
      i++;
      j++;
    } else if (lcs[at(i + 1, j)]! >= lcs[at(i, j + 1)]!) {
      outLeft.push({ op: "changed", text: left[i]! });
      i++;
    } else {
      outRight.push({ op: "changed", text: right[j]! });
      j++;
    }
  }
  while (i < n) outLeft.push({ op: "changed", text: left[i++]! });
  while (j < m) outRight.push({ op: "changed", text: right[j++]! });

  return { left: outLeft, right: outRight, computed: true };
}

/**
 * Render a decrypted response body as text for display.
 *
 * `null` means the API had nothing to show (no capture, purged, or
 * undecryptable) — the caller renders an explanation instead, never an empty
 * panel that reads like "the model replied nothing".
 */
export function bodyToText(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return null;
  }
}
