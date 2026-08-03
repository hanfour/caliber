import { describe, it, expect } from "vitest";
import { replayOfHeader, REPLAY_OF_HEADER } from "../../src/runtime/replayOfHeader.js";

function req(opts: { keyPrefix?: string; header?: string }) {
  return {
    apiKey: opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : null,
    headers: opts.header ? { [REPLAY_OF_HEADER]: opts.header } : {},
  };
}

describe("replayOfHeader", () => {
  it("以 eval key 認證時信任 header", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval", header: "req-123" }))).toBe("req-123");
  });

  it("以一般成員 key 認證時丟棄 header（防偽核心）", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber", header: "req-123" }))).toBeUndefined();
  });

  it("未認證時丟棄 header", () => {
    expect(replayOfHeader(req({ header: "req-123" }))).toBeUndefined();
  });

  it("eval key 但無 header → undefined", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval" }))).toBeUndefined();
  });

  it("header 為空字串 → undefined（不得寫入空字串）", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval", header: "" }))).toBeUndefined();
  });

  it("header 重複出現時取第一個", () => {
    const r = {
      apiKey: { keyPrefix: "caliber-eval" },
      headers: { [REPLAY_OF_HEADER]: ["req-a", "req-b"] },
    };
    expect(replayOfHeader(r)).toBe("req-a");
  });
});
