// Pure decision function for the requests-list page's "重放" button state.
//
// Deliberately has zero React/DOM dependency so it can be unit tested without
// jsdom or a mocked tRPC client — the three disabled conditions this file
// encodes are exactly the acceptance criteria from the single-request-replay
// Task 10 brief, and a component test alone cannot force every combination
// (e.g. replayEnabled=false is only true in a deployment where
// ENABLE_EVALUATOR is off, which the E2E harness cannot flip on a shared
// webServer — see task-10-report.md).
//
// Order of checks matters for the MESSAGE shown, not just the boolean:
// `replayEnabled` is a page-wide capability signal (every row is affected
// identically), so it is checked first and produces a distinct reason from
// the two per-row body-state checks. The caller renders the `replayEnabled:
// false` case as a single page-level banner rather than repeating the same
// sentence on every row — see RequestsTable.tsx.
export type ReplayGateReason = "replayDisabled" | "truncated" | "noBody";

export type ReplayGate =
  | { disabled: false }
  | { disabled: true; reason: ReplayGateReason };

export interface ReplayGateInput {
  bodyTruncated: boolean;
  hasBody: boolean;
}

export function getReplayGate(
  row: ReplayGateInput,
  replayEnabled: boolean,
): ReplayGate {
  if (!replayEnabled) {
    return { disabled: true, reason: "replayDisabled" };
  }
  // Say it BEFORE the user spends money: both of these are UX preconditions
  // that mirror replay.enqueue's own server-side precondition checks
  // (apps/api/src/trpc/routers/replay.ts) so a click that reaches the
  // server never fails for a reason this page could have shown up front.
  if (row.bodyTruncated) {
    return { disabled: true, reason: "truncated" };
  }
  if (!row.hasBody) {
    return { disabled: true, reason: "noBody" };
  }
  return { disabled: false };
}
