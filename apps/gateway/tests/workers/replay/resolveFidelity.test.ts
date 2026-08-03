import { describe, it, expect } from "vitest";
import { resolveFidelity } from "../../../src/workers/replay/resolveFidelity.js";

const base = {
  bodyTruncated: false,
  toolResultTruncated: false,
  cacheReadTokens: 0,
  accountId: "acc-1",
  accountStillExists: true,
};

describe("resolveFidelity", () => {
  it("body_truncated 一律拒絕重放", () => {
    const r = resolveFidelity({ ...base, bodyTruncated: true });
    expect(r.replayable).toBe(false);
    expect(r.failureReason).toBe("truncated_not_replayable");
  });

  it("tool_result_truncated 允許重放但記錄旗標", () => {
    const r = resolveFidelity({ ...base, toolResultTruncated: true });
    expect(r.replayable).toBe(true);
    expect(r.fidelity.toolResultTruncated).toBe(true);
  });

  it("永遠記錄 streamingDisabled，因為重放強制關閉串流", () => {
    expect(resolveFidelity(base).fidelity.streamingDisabled).toBe(true);
  });

  it("保留原始 cache_read_tokens 供 UI 判斷延遲與成本是否可比", () => {
    const r = resolveFidelity({ ...base, cacheReadTokens: 48213 });
    expect(r.fidelity.originalCacheReadTokens).toBe(48213);
  });

  it("記錄原上游帳號是否仍存在", () => {
    const r = resolveFidelity({ ...base, accountStillExists: false });
    expect(r.replayable).toBe(true);
    expect(r.fidelity.originalAccountStillExists).toBe(false);
  });
});
