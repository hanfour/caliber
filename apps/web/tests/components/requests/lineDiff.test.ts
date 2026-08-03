import { describe, it, expect } from "vitest";
import {
  lineDiff,
  bodyToText,
  MAX_DIFF_LINES,
} from "@/components/requests/lineDiff";

describe("lineDiff", () => {
  it("marks nothing when both sides are identical", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.computed).toBe(true);
    expect(d.left.every((l) => l.op === "same")).toBe(true);
    expect(d.right.every((l) => l.op === "same")).toBe(true);
  });

  it("marks only the line that changed", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d.left.filter((l) => l.op === "changed").map((l) => l.text)).toEqual([
      "b",
    ]);
    expect(
      d.right.filter((l) => l.op === "changed").map((l) => l.text),
    ).toEqual(["B"]);
  });

  it("does not report every following line as changed after an insertion", () => {
    // The whole reason this is an LCS alignment and not an index-by-index
    // walk: with index alignment, inserting one line at the top would mark
    // the ENTIRE rest of both bodies as different, which is the exact
    // misleading answer this page must not give.
    const d = lineDiff("a\nb\nc", "new\na\nb\nc");
    expect(
      d.right.filter((l) => l.op === "changed").map((l) => l.text),
    ).toEqual(["new"]);
    expect(d.left.filter((l) => l.op === "changed")).toHaveLength(0);
  });

  it("keeps every original line on each side", () => {
    const d = lineDiff("a\nb", "x\ny\nz");
    expect(d.left.map((l) => l.text)).toEqual(["a", "b"]);
    expect(d.right.map((l) => l.text)).toEqual(["x", "y", "z"]);
  });

  it("skips the alignment past the size cap instead of freezing the tab", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join(
      "\n",
    );
    const d = lineDiff(big, "a");
    expect(d.computed).toBe(false);
    expect(d.left.every((l) => l.op === "same")).toBe(true);
    expect(d.right.every((l) => l.op === "same")).toBe(true);
  });
});

describe("bodyToText", () => {
  it("pretty-prints an object", () => {
    expect(bodyToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("passes a raw string through (a truncated capture is not JSON)", () => {
    expect(bodyToText("not json")).toBe("not json");
  });

  it("returns null when there is nothing to show", () => {
    expect(bodyToText(null)).toBeNull();
    expect(bodyToText(undefined)).toBeNull();
  });
});
