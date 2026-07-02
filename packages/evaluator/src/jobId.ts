/**
 * Deterministic BullMQ-safe evaluator job id. BullMQ 5.x rejects custom ids
 * containing ':' (unless they split into exactly 3 parts); our ISO periodStart
 * embeds colons, so segments are joined with '_' and every ':' is stripped to
 * '-'. Collision-safe: per-person (3 segments) can never equal per-key (4
 * segments) because a UUID apiKeyId never equals an ISO periodStart.
 */
export function buildEvaluatorJobId(input: {
  userId: string;
  apiKeyId?: string | null;
  periodStart: string;
  periodType: string;
}): string {
  const parts = input.apiKeyId
    ? [input.userId, input.apiKeyId, input.periodStart, input.periodType]
    : [input.userId, input.periodStart, input.periodType];
  return parts.join("_").replaceAll(":", "-");
}
