/**
 * Deterministic BullMQ-safe evaluator job id. BullMQ 5.x rejects custom ids
 * containing ':' (unless they split into exactly 3 parts); our ISO periodStart
 * embeds colons, so segments are joined with '_' and every ':' is stripped to
 * '-'. The org-scoped v2 shape matches the evaluation_reports uniqueness
 * invariant and keeps the per-person/per-key grains unambiguous.
 */
export function buildEvaluatorJobId(input: {
  orgId: string;
  userId: string;
  apiKeyId?: string | null;
  periodStart: string;
  periodType: "daily" | "weekly" | "monthly";
}): string {
  const parts = input.apiKeyId
    ? [
        "eval",
        "v2",
        "key",
        input.orgId,
        input.userId,
        input.apiKeyId,
        input.periodStart,
        input.periodType,
      ]
    : [
        "eval",
        "v2",
        "person",
        input.orgId,
        input.userId,
        input.periodStart,
        input.periodType,
      ];
  return parts.join("_").replaceAll(":", "-");
}
