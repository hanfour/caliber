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

/**
 * The run is `running` and has not been heard from within the API's window.
 *
 * NOT terminal, and the difference matters: the window is measured from row
 * creation (`replay_runs` has no claim timestamp), so it includes queue time,
 * and with a `concurrency: 1` worker a deep backlog can push a perfectly
 * healthy run past it. The page must keep watching so a late run replaces this
 * warning with its own result — telling the operator to start over would spend
 * a second billed replay on a run that was fine.
 */
export const STALE_RUNNING_REASON = "stale_running";

/**
 * Nothing has claimed the run — it is still `queued` past the API's window.
 *
 * NOT terminal either, and for a cause the operator can act on: the ordinary
 * way to reach it is a deployment where nothing consumes the replay queue (the
 * gateway's replay worker lives inside its evaluator pipeline, so the API can
 * accept and enqueue while the other side never runs). A late-starting run must
 * still be able to replace this warning, so the page keeps watching.
 */
export const STALE_QUEUED_REASON = "stale_queued";

/**
 * The run finished upstream but its own usage row never landed. Terminal: the
 * money is spent and the result is unrecoverable, so re-running is the only
 * recourse and the page must stop pretending it is still loading.
 */
export const RESULT_MISSING_REASON = "result_missing";

const KNOWN_REASONS = new Set([
  "truncated_not_replayable",
  "body_missing",
  "retention_expired",
  "decrypt_failed",
  "eval_key_unavailable",
  "missing_request_id",
  STALE_RUNNING_REASON,
  STALE_QUEUED_REASON,
  RESULT_MISSING_REASON,
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
