import { describe, it, expect } from "vitest";
import { extractLatestHumanText } from "../../src/signals/humanText.js";

const NOISE = ["<system-reminder>", "<command-name>"];

describe("extractLatestHumanText", () => {
  it("takes only the LAST user message (no history snowball)", () => {
    const body = {
      system: "you like to refactor",
      messages: [
        { role: "user", content: [{ type: "text", text: "please refactor this" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "now add tests" }] },
      ],
    };
    expect(extractLatestHumanText(body, [])).toBe("now add tests");
  });

  it("returns null when the last user message is pure tool_result", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "refactor optimize" }] },
      ],
    };
    expect(extractLatestHumanText(body, [])).toBeNull();
  });

  it("drops text blocks containing a noise marker (case-insensitive)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<System-Reminder> injected refactor noise" },
            { type: "text", text: "real question" },
          ],
        },
      ],
    };
    expect(extractLatestHumanText(body, NOISE)).toBe("real question");
  });

  it("supports plain-string content and transcript-shaped bodies", () => {
    expect(
      extractLatestHumanText({ messages: [{ role: "user", content: "try another approach" }] }, []),
    ).toBe("try another approach");
    const tx = {
      model: "unknown",
      messages: [
        { role: "user", content: "" },
        { role: "user", content: [{ type: "text", text: "比較兩個方案" }] },
      ],
    };
    expect(extractLatestHumanText(tx, [])).toBe("比較兩個方案");
  });

  it("returns null for malformed bodies", () => {
    expect(extractLatestHumanText(null, [])).toBeNull();
    expect(extractLatestHumanText("raw", [])).toBeNull();
    expect(extractLatestHumanText({ messages: "x" }, [])).toBeNull();
  });
});
