/**
 * `replay_runs.failure_reason` 的封閉列舉（Task 6, single-request-replay）。
 *
 * 獨立成一個模組，是為了讓 `resolveFidelity.ts` 與 `runReplay.ts` 都能引用而不
 * 產生循環相依（`runReplay` 已經 import `resolveFidelity`）。
 */

/** 七個允許的基底值。任一失敗路徑都必須寫入其中之一。 */
export const REPLAY_FAILURE_REASONS = [
  "truncated_not_replayable",
  "body_missing",
  "retention_expired",
  "decrypt_failed",
  "eval_key_unavailable",
  "upstream_error",
  "missing_request_id",
] as const;

export type ReplayFailureReason = (typeof REPLAY_FAILURE_REASONS)[number];

/**
 * 上游失敗會附上 HTTP status code，例如 `upstream_error:503`。
 *
 * 這個後綴形式是**契約的一部分**，不是「剛好以合法前綴開頭的字串」。它必須被
 * 明確寫進型別，否則消費端（Task 10/11 要渲染這個欄位）很容易寫成
 * `failureReason === "upstream_error"`，而那樣會漏掉**每一筆**上游失敗。
 * 要判斷是否為上游失敗，請用 `isUpstreamErrorReason()`。
 */
export type ReplayUpstreamErrorReason = `upstream_error:${number}`;

/** 實際會被寫進 `replay_runs.failure_reason` 的完整值域。 */
export type ReplayFailureReasonWritten =
  ReplayFailureReason | ReplayUpstreamErrorReason;

/**
 * 是否為上游失敗（含帶 status code 的後綴形式）。
 *
 * 消費端請一律用這個函式，不要直接比對字串相等。
 */
export function isUpstreamErrorReason(
  reason: string | null | undefined,
): reason is ReplayUpstreamErrorReason | "upstream_error" {
  return (
    reason === "upstream_error" ||
    reason?.startsWith("upstream_error:") === true
  );
}
