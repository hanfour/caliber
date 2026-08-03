import type { ReplayFailureReason } from "./failureReasons.js";

export interface Fidelity {
  toolResultTruncated: boolean;
  originalCacheReadTokens: number;
  originalAccountId: string | null;
  originalAccountStillExists: boolean;
  /** 重放一律關閉串流，故延遲數字與原請求不可比。恆為 true。 */
  streamingDisabled: true;
}

export interface ResolveFidelityInput {
  bodyTruncated: boolean;
  toolResultTruncated: boolean;
  cacheReadTokens: number;
  accountId: string | null;
  accountStillExists: boolean;
}

export interface ResolveFidelityResult {
  replayable: boolean;
  /** 封閉列舉，不是任意字串——見 `failureReasons.ts`。 */
  failureReason?: ReplayFailureReason;
  fidelity: Fidelity;
}

/**
 * 判定一筆請求是否可重放，並產出保真度旗標。
 *
 * 只有 body_truncated 是硬性阻擋：body 被截斷代表我們手上的根本不是原始輸入，
 * 重放結果無法歸因於模型，讓它跑只會產出「看起來嚴謹、實際錯誤」的結論。
 * 其餘旗標一律放行但據實記錄，由 UI 揭露給使用者判斷。
 */
export function resolveFidelity(
  input: ResolveFidelityInput,
): ResolveFidelityResult {
  const fidelity: Fidelity = {
    toolResultTruncated: input.toolResultTruncated,
    originalCacheReadTokens: input.cacheReadTokens,
    originalAccountId: input.accountId,
    originalAccountStillExists: input.accountStillExists,
    streamingDisabled: true,
  };

  if (input.bodyTruncated) {
    return {
      replayable: false,
      failureReason: "truncated_not_replayable",
      fidelity,
    };
  }
  return { replayable: true, fidelity };
}
