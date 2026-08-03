/**
 * Replay comparison assembly (Task 11, single-request-replay).
 *
 * Lives in `services/` rather than inside `trpc/routers/replay.ts` because it
 * is a different kind of work from that file's thin authorise-and-write
 * procedures: it decrypts captured content, reads two `request_bodies` rows,
 * and decides what may honestly be compared. `replay.getComparison` stays a
 * boundary (validate input → call this → return).
 *
 * The whole point of this endpoint is to answer "was that the model's fault,
 * or ours?", so the failure mode that matters most is not a crash — it is a
 * number that LOOKS comparable and is not. Two rules exist for that reason and
 * must survive any future edit:
 *
 *  1. **`comparable.latency` is unconditionally false.** apps/gateway's
 *     `buildReplayBody` forces `stream: false`, so the source's `duration_ms`
 *     (often time-to-last-token of a streamed response) and the replay's
 *     (a single blocking round trip) do not measure the same thing. There is
 *     no input that makes them comparable, so there is no condition here.
 *
 *  2. **`comparable.cost` is false whenever the source read from cache.** The
 *     replay always runs against a cold prompt cache, so a source request that
 *     paid discounted cache-read rates is not being priced like the replay.
 *
 * A third rule covers the worker's one-way claim: `queued → running` has no
 * sweeper anywhere in this codebase, so a process crash mid-replay strands the
 * row at `running` permanently. Reporting that as "still working" would be a
 * lie that never resolves — see `REPLAY_STALE_RUNNING_MS`.
 */

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@caliber/db";
import { replayRuns, requestBodies, usageLogs } from "@caliber/db";
import { decryptStoredBody } from "@caliber/gateway-core";
import { can } from "@caliber/auth";
import { requireMasterKeyHex } from "../trpc/routers/_credentials.js";

// ─── Stale-claim policy ───────────────────────────────────────────────────────

/**
 * How long a `running` row may go without completing before this endpoint
 * reports it as failed.
 *
 * Generous on purpose: a single replay is one blocking upstream call, which
 * this project has measured at 50–111s against a slow model, and the worker
 * runs `concurrency: 1` so a run can also sit behind another one. Fifteen
 * minutes is far beyond any legitimate single replay and far below "the
 * operator gave up and refreshed all afternoon".
 *
 * Exported so the test asserts against the same number the service enforces.
 */
export const REPLAY_STALE_RUNNING_MS = 15 * 60 * 1000;

/**
 * The synthetic `failureReason` for the case above.
 *
 * Deliberately NOT one of `apps/gateway/src/workers/replay/failureReasons.ts`'s
 * values: those describe something the worker observed and wrote down. This one
 * means the opposite — the worker never came back to write anything — and the
 * UI must say so in those words rather than inventing a cause.
 */
export const STALE_RUNNING_FAILURE_REASON = "stale_running";

/** Reported when `replay_runs.status` holds a value this build does not know. */
export const UNKNOWN_STATUS_FAILURE_REASON = "unknown_status";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReplayComparisonStatus = "queued" | "running" | "ok" | "failed";

const runStatusSchema = z.enum(["queued", "running", "ok", "failed"]);

/**
 * `replay_runs.fidelity` is `jsonb` written by another process (apps/gateway's
 * `resolveFidelity`), so it is external data and gets validated here like any
 * other boundary input. Unknown keys are stripped by default, which also keeps
 * a future gateway-side field from reaching the browser unreviewed.
 *
 * `streamingDisabled` is typed `true` at the source and is always written that
 * way; it is accepted as a plain boolean here so that one drifted flag cannot
 * blank out the tool-result / account caveats the operator actually needs. The
 * page states the streaming caveat unconditionally regardless of this value —
 * it is a property of how replay works, not of any individual row.
 */
const fidelitySchema = z.object({
  toolResultTruncated: z.boolean(),
  originalCacheReadTokens: z.number(),
  originalAccountId: z.string().nullable(),
  originalAccountStillExists: z.boolean(),
  streamingDisabled: z.boolean(),
});

export type ReplayFidelity = z.infer<typeof fidelitySchema>;

export interface ComparisonSide {
  /** The model the caller asked for (`usage_logs.requested_model`). */
  model: string;
  /** What the gateway actually resolved that to. */
  upstreamModel: string;
  /**
   * The decrypted response body: parsed JSON when it parses, the raw text when
   * it does not (a truncated capture), and `null` when there is nothing to
   * show — no captured row, or a blob this deployment could not decrypt.
   */
  responseBody: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** `numeric(20,10)` — kept as a string so no precision is lost in transit. */
  totalCost: string;
  durationMs: number;
}

export interface ReplayComparison {
  source: ComparisonSide;
  /**
   * `null` until the replay has both finished AND had its own `usage_logs` row
   * written by the gateway's (separate, asynchronous) usage pipeline. A caller
   * seeing `status === "ok"` with `replay === null` is looking at that window,
   * not at a missing result — poll, do not conclude.
   */
  replay: ComparisonSide | null;
  status: ReplayComparisonStatus;
  failureReason: string | null;
  fidelity: ReplayFidelity | null;
  comparable: { latency: boolean; cost: boolean };
}

export interface GetReplayComparisonInput {
  db: Database;
  env: { CREDENTIAL_ENCRYPTION_KEY?: string };
  perm: Parameters<typeof can>[0];
  orgId: string;
  runId: string;
  logger: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

// ─── Internals ────────────────────────────────────────────────────────────────

const sideColumns = {
  requestedModel: usageLogs.requestedModel,
  upstreamModel: usageLogs.upstreamModel,
  inputTokens: usageLogs.inputTokens,
  outputTokens: usageLogs.outputTokens,
  cacheReadTokens: usageLogs.cacheReadTokens,
  totalCost: usageLogs.totalCost,
  durationMs: usageLogs.durationMs,
  userId: usageLogs.userId,
  responseBodySealed: requestBodies.responseBodySealed,
};

/**
 * One captured request plus its sealed response body, if the body row exists.
 *
 * LEFT JOIN, not INNER: a request whose body was purged by retention still has
 * perfectly good token/cost/latency numbers, and hiding the whole side because
 * the text is gone would throw away the half of the comparison that survives.
 */
async function loadSide(db: Database, orgId: string, requestId: string) {
  return db
    .select(sideColumns)
    .from(usageLogs)
    .leftJoin(requestBodies, eq(requestBodies.requestId, usageLogs.requestId))
    .where(and(eq(usageLogs.requestId, requestId), eq(usageLogs.orgId, orgId)))
    .limit(1)
    .then((r) => r[0]);
}

/** Inferred from the query above — no hand-written shape to drift from it. */
type SideRow = NonNullable<Awaited<ReturnType<typeof loadSide>>>;

function toSide(row: SideRow, responseBody: unknown): ComparisonSide {
  return {
    model: row.requestedModel,
    upstreamModel: row.upstreamModel,
    responseBody,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalCost: row.totalCost,
    durationMs: row.durationMs,
  };
}

/**
 * Decrypt one stored response body for display.
 *
 * Never throws: an unreadable blob on one side must not take down the metrics
 * on both. It returns `null` and logs, and the page says so in words rather
 * than rendering an empty panel that reads like "the model replied nothing".
 *
 * The log carries ids and the error message only — never any plaintext.
 */
function decryptForDisplay(input: {
  masterKeyHex: string;
  requestId: string;
  sealed: Buffer | null;
  logger: GetReplayComparisonInput["logger"];
}): unknown {
  if (!input.sealed) return null;
  let plaintext: string;
  try {
    plaintext = decryptStoredBody({
      masterKeyHex: input.masterKeyHex,
      requestId: input.requestId,
      stored: input.sealed,
    });
  } catch (err) {
    input.logger.warn(
      {
        requestId: input.requestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "replay comparison: could not decrypt a captured response body",
    );
    return null;
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    // A truncated capture is no longer valid JSON. The raw text is still the
    // most useful thing we have, so hand it over rather than blanking it.
    return plaintext;
  }
}

/**
 * The run's status as the reader should understand it.
 *
 * Read-only: the row is deliberately NOT rewritten. apps/gateway's claim fence
 * is one-way precisely so a used run can never be re-claimed and billed twice;
 * flipping `running → failed` from a GET would reopen exactly that door.
 */
function effectiveStatus(
  rawStatus: string,
  createdAt: Date,
  storedReason: string | null,
  nowMs: number,
): { status: ReplayComparisonStatus; failureReason: string | null } {
  const parsed = runStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    return { status: "failed", failureReason: UNKNOWN_STATUS_FAILURE_REASON };
  }
  if (
    parsed.data === "running" &&
    nowMs - createdAt.getTime() > REPLAY_STALE_RUNNING_MS
  ) {
    return { status: "failed", failureReason: STALE_RUNNING_FAILURE_REASON };
  }
  return { status: parsed.data, failureReason: storedReason };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function getReplayComparison(
  input: GetReplayComparisonInput,
): Promise<ReplayComparison> {
  const { db, orgId, runId, logger } = input;
  const nowMs = Date.now();

  // Scoped by org as well as id, so a run belonging to another org is
  // indistinguishable from one that does not exist (same rule as every other
  // procedure in replay.ts — probing ids across orgs must confirm nothing).
  const run = await db
    .select({
      sourceRequestId: replayRuns.sourceRequestId,
      replayRequestId: replayRuns.replayRequestId,
      status: replayRuns.status,
      failureReason: replayRuns.failureReason,
      fidelity: replayRuns.fidelity,
      createdAt: replayRuns.createdAt,
    })
    .from(replayRuns)
    .where(and(eq(replayRuns.id, runId), eq(replayRuns.orgId, orgId)))
    .limit(1)
    .then((r) => r[0]);

  if (!run) throw new TRPCError({ code: "NOT_FOUND" });

  const source = await loadSide(db, orgId, run.sourceRequestId);
  if (!source) throw new TRPCError({ code: "NOT_FOUND" });

  // Reading a comparison IS reading the source request's decrypted content, so
  // it takes the same permission as starting a replay. Mirrors
  // `assertCanReplay` in trpc/routers/replay.ts; kept inline rather than
  // imported to avoid a service ⇄ router import cycle.
  if (
    !can(input.perm, {
      type: "request.replay",
      orgId,
      targetUserId: source.userId,
    })
  ) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }

  // Checked only after authorisation: an unauthorised caller learns nothing
  // about this deployment's configuration.
  const masterKeyHex = requireMasterKeyHex(input.env, {
    code: "PRECONDITION_FAILED",
    message:
      "Cannot show captured content: CREDENTIAL_ENCRYPTION_KEY is not configured on this API server",
  });

  const { status, failureReason } = effectiveStatus(
    run.status,
    run.createdAt,
    run.failureReason,
    nowMs,
  );

  const fidelityParsed = fidelitySchema.safeParse(run.fidelity);

  // Only an `ok` run has an upstream result worth comparing. `replayRequestId`
  // is additionally required because a run can be `ok` before its own
  // usage_logs row has landed — see ReplayComparison.replay.
  const replayRow =
    status === "ok" && run.replayRequestId
      ? await loadSide(db, orgId, run.replayRequestId)
      : undefined;

  return {
    source: toSide(
      source,
      decryptForDisplay({
        masterKeyHex,
        requestId: run.sourceRequestId,
        sealed: source.responseBodySealed,
        logger,
      }),
    ),
    replay:
      replayRow && run.replayRequestId
        ? toSide(
            replayRow,
            decryptForDisplay({
              masterKeyHex,
              requestId: run.replayRequestId,
              sealed: replayRow.responseBodySealed,
              logger,
            }),
          )
        : null,
    status,
    failureReason,
    fidelity: fidelityParsed.success ? fidelityParsed.data : null,
    comparable: {
      // Rule 1 — see the file header. No condition, by design.
      latency: false,
      // Rule 2 — the replay always runs cold.
      cost: source.cacheReadTokens === 0,
    },
  };
}
