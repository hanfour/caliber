import { describe, it, expect } from "vitest";
import { replayOfHeader, REPLAY_OF_HEADER } from "../../src/runtime/replayOfHeader.js";

function req(opts: { keyPrefix?: string; header?: string }) {
  return {
    apiKey: opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : null,
    // NOTE: must distinguish "header omitted" from "header sent as the empty
    // string" — `opts.header ? … : {}` collapsed both to an absent header,
    // which meant the "header 為空字串" case below never actually built a
    // `""`-valued header (see task-3-report.md fix round for the review
    // finding this fixes).
    headers:
      opts.header === undefined ? {} : { [REPLAY_OF_HEADER]: opts.header },
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

  it("header 為純空白字串 → undefined（同一漏洞類別：'   ' IS NULL 為 false，會逃過評分排除）", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval", header: "   " }))).toBeUndefined();
  });

  it("header 重複出現時取第一個", () => {
    const r = {
      apiKey: { keyPrefix: "caliber-eval" },
      headers: { [REPLAY_OF_HEADER]: ["req-a", "req-b"] },
    };
    expect(replayOfHeader(r)).toBe("req-a");
  });
});
