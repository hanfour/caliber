/**
 * `replay_runs.failure_reason` → the i18n key (and values) that explain it.
 *
 * The upstream-failure variant carries an HTTP status (`upstream_error:503`),
 * which is part of the contract, not an accident of formatting. Comparing the
 * whole string for equality with `"upstream_error"` would therefore miss EVERY
 * real upstream failure — apps/gateway exports `isUpstreamErrorReason()`
 * specifically to stop that, and `hasUpstreamErrorPrefix` below is that same
 * predicate. It is restated here rather than imported because apps/web cannot
 * depend on apps/gateway (see apps/web/package.json); if the vocabulary ever
 * moves into a shared package, delete this copy and import the original.
 *
 * Source of truth: apps/gateway/src/workers/replay/failureReasons.ts, plus the
 * two synthetic reasons apps/api's replayComparison service can report for a
 * run the worker never came back to finish.
 */

const UPSTREAM_ERROR_PREFIX = "upstream_error";

export interface FailureReasonMessage {
  /** Key under the `replayComparison.reason` namespace. */
  key: string;
  values?: Record<string, string | number>;
}

const KNOWN_REASONS = new Set([
  "truncated_not_replayable",
  "body_missing",
  "retention_expired",
  "decrypt_failed",
  "eval_key_unavailable",
  "missing_request_id",
  "stale_running",
  "unknown_status",
]);

function hasUpstreamErrorPrefix(reason: string): boolean {
  return (
    reason === UPSTREAM_ERROR_PREFIX ||
    reason.startsWith(`${UPSTREAM_ERROR_PREFIX}:`)
  );
}

export function describeFailureReason(
  reason: string | null,
): FailureReasonMessage | null {
  if (!reason) return null;

  if (hasUpstreamErrorPrefix(reason)) {
    const status = reason.slice(UPSTREAM_ERROR_PREFIX.length + 1);
    return status
      ? { key: "upstream_error", values: { status } }
      : { key: "upstream_error_nostatus" };
  }

  if (KNOWN_REASONS.has(reason)) return { key: reason };

  // Never swallow an unrecognised reason: showing the raw value is worse copy
  // but a true statement, and it is what a future gateway reason will hit.
  return { key: "unknown", values: { reason } };
}
