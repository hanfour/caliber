import { describe, it, expect } from "vitest";
import { buildReplayBody } from "../../../src/workers/replay/buildReplayBody.js";

const original = {
  model: "claude-opus-4-5",
  stream: true,
  max_tokens: 4096,
  temperature: 0.7,
  system: "you are helpful",
  tools: [{ name: "grep", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: "u1" },
};

describe("buildReplayBody", () => {
  it("只改 model 與 stream 兩欄，其餘逐欄相同", () => {
    const out = buildReplayBody(original, "claude-sonnet-5");
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.stream).toBe(false);

    const { model: _m1, stream: _s1, ...restIn } = original;
    const { model: _m2, stream: _s2, ...restOut } = out;
    expect(restOut).toEqual(restIn);
  });

  it("不就地修改原物件（不可變）", () => {
    const snapshot = JSON.parse(JSON.stringify(original));
    buildReplayBody(original, "claude-sonnet-5");
    expect(original).toEqual(snapshot);
  });

  it("原 body 沒有 stream 欄位時仍明確補上 false", () => {
    const { stream: _drop, ...noStream } = original;
    expect(buildReplayBody(noStream, "claude-sonnet-5").stream).toBe(false);
  });

  it("原 body 非物件時擲錯", () => {
    expect(() => buildReplayBody("not-an-object", "claude-sonnet-5")).toThrow();
    expect(() => buildReplayBody(null, "claude-sonnet-5")).toThrow();
  });
});
