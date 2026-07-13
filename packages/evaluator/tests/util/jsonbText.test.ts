import { describe, it, expect } from "vitest";
import {
  stripInvalidJsonbChars,
  deepStripInvalidJsonbChars,
} from "../../src/util/jsonbText";

/** True when `s` contains a UTF-16 surrogate that is not part of a valid pair. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("stripInvalidJsonbChars", () => {
  it("preserves a valid surrogate pair (emoji)", () => {
    const s = "a😀b";
    expect(stripInvalidJsonbChars(s)).toBe(s);
  });

  it("drops a lone high surrogate (emoji cut at its end)", () => {
    const s = "code UI - 1.0\n- \uD83D"; // high half only, mirrors the real crash
    const out = stripInvalidJsonbChars(s);
    expect(out).toBe("code UI - 1.0\n- ");
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("drops a lone low surrogate (emoji cut at its start)", () => {
    expect(stripInvalidJsonbChars("\uDE00rest")).toBe("rest");
  });

  it("drops a NUL character (also invalid in jsonb)", () => {
    const withNul = "a" + String.fromCharCode(0) + "b";
    expect(stripInvalidJsonbChars(withNul)).toBe("ab");
  });

  it("leaves ordinary CJK / punctuation untouched", () => {
    const s = "廣告主 / Company 管理 UI";
    expect(stripInvalidJsonbChars(s)).toBe(s);
  });

  it("keeps valid pairs while removing an adjacent lone half", () => {
    const s = "😀\uD83D"; // one valid pair, then a lone high surrogate
    const out = stripInvalidJsonbChars(s);
    expect(out).toBe("😀");
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

describe("deepStripInvalidJsonbChars", () => {
  it("cleans strings nested in objects and arrays", () => {
    const input = {
      total: 120,
      ok: true,
      nothing: null,
      sections: [{ name: "S", quote: "x\uD83D", inner: { q: "\uDE00y" } }],
    };
    const out = deepStripInvalidJsonbChars(input);
    expect(out.sections[0]!.quote).toBe("x");
    expect(out.sections[0]!.inner.q).toBe("y");
    expect(out.total).toBe(120);
    expect(out.ok).toBe(true);
    expect(out.nothing).toBe(null);
  });

  it("does not mutate the original object (immutability)", () => {
    const input = { q: "x\uD83D" };
    const out = deepStripInvalidJsonbChars(input);
    expect(input.q).toBe("x\uD83D");
    expect(out.q).toBe("x");
    expect(out).not.toBe(input);
  });

  it("passes primitives through unchanged", () => {
    expect(deepStripInvalidJsonbChars(5)).toBe(5);
    expect(deepStripInvalidJsonbChars(null)).toBe(null);
    expect(deepStripInvalidJsonbChars("clean")).toBe("clean");
  });
});
