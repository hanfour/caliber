/**
 * 產生重放用的 request body：只覆寫 `model` 與 `stream`，其餘原封不動。
 *
 * 唯一變因必須是模型，否則差異無法歸因。強制 stream:false 是為了拿到完整 body
 * 好做比對——代價是延遲數字不可比，該事實由 resolveFidelity 記入 fidelity。
 */
export function buildReplayBody(
  originalBody: unknown,
  targetModel: string,
): Record<string, unknown> {
  if (originalBody === null || typeof originalBody !== "object" || Array.isArray(originalBody)) {
    throw new Error("replay: original request body is not a JSON object");
  }
  return {
    ...(originalBody as Record<string, unknown>),
    model: targetModel,
    stream: false,
  };
}
