/**
 * Single-request replay API surface (Task 8, single-request-replay).
 *
 * `enqueue` is the most expensive mutation in this codebase: every accepted
 * call spends real money on a real upstream request AND decrypts another
 * person's full prompt text inside the worker. Rate limiting and audit logging
 * are therefore part of this endpoint's contract, not a later hardening pass —
 * without them the button can be click-spammed until the budget is gone, and
 * nothing records who read whose prompts.
 *
 * Three invariants that must survive any future edit:
 *
 *  1. **Enqueue happens strictly AFTER the `replay_runs` INSERT commits.**
 *     apps/gateway's `runReplay` claims a row by moving it `queued → running`
 *     and, when the claim matches nothing, logs and DROPS the job with no
 *     retry. A job delivered before the transaction commits is therefore lost
 *     silently — the row would sit at `queued` forever with no failure reason.
 *
 *  2. **There is no "retry this run" operation.** The claim is deliberately
 *     one-way, so a used run can never be re-claimed. Retrying means calling
 *     `enqueue` again, which INSERTs a new row. Neither `get` nor
 *     `listForRequest` may grow an affordance that implies otherwise.
 *
 *  3. **The fidelity precheck here is a UX affordance, not the authority.**
 *     apps/gateway's `resolveFidelity` is the real gate and must keep existing;
 *     this copy only spares the user a queued run that was always going to
 *     fail. Both must exist — deleting either one is a defect.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { replayRuns, requestBodies, usageLogs } from "@caliber/db";
import { can } from "@caliber/auth";
import { enqueueReplay, type QueueLike as ReplayQueue } from "@caliber/queue";
import { formatValidationKey } from "@caliber/i18n-validation";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { writeAudit } from "../../services/audit.js";
import { getReplayComparison } from "../../services/replayComparison.js";

// Re-exported for downstream importers (trpc/procedures.ts, trpc/context.ts,
// apps/api/src/server.ts) — mirrors how reports.ts re-exports EvaluatorQueue.
export type { ReplayQueue };

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum replays a single user may start per rolling hour.
 *
 * Exported (not inlined) so the tests assert against the same number the
 * handler enforces — a literal buried in the handler would let the limit drift
 * away from its test silently.
 *
 * Counted per user across every org they belong to rather than per (user, org).
 * That is the stricter reading on purpose: the resource being protected is
 * money plus other people's decrypted prompts, and an org-scoped counter would
 * let a member of several orgs multiply their own ceiling.
 */
export const REPLAY_HOURLY_LIMIT = 20;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** `auditLogs.action` written for every accepted replay. */
const REPLAY_AUDIT_ACTION = "request.replay";

/**
 * `audit_logs.target_id` is a `uuid` column, but `usage_logs.request_id` is
 * `text`. Every id the gateway mints is a uuid (`genReqId: () => randomUUID()`),
 * so in practice they always agree — but the schema does not guarantee it, and
 * a non-uuid request id would make the audit INSERT fail with a raw Postgres
 * type error, rolling back an otherwise legitimate replay.
 *
 * So: narrow to the column's type, and rely on `metadata.sourceRequestId`,
 * which always carries the exact text id, as the audit's authoritative link
 * back to the source request.
 */
function asAuditTargetId(requestId: string): string | undefined {
  return z.string().uuid().safeParse(requestId).success ? requestId : undefined;
}

// ─── Input schemas ────────────────────────────────────────────────────────────

// `usage_logs.request_id` is free-form text produced by the gateway, so it is
// bounded rather than shape-constrained. The length cap keeps a hostile input
// from turning into an oversized query parameter.
const requestIdInput = z.string().min(1).max(200);

// Deliberately NOT constrained to a model catalog: the gateway resolves aliases
// at request time and owns that list, so a copy here would reject models the
// gateway accepts. Bounded and non-blank is the boundary's job; validity is the
// upstream's answer, surfaced as a failed run.
const targetModelInput = z
  .string()
  .trim()
  .min(1)
  .max(200);

const enqueueInput = z.object({
  orgId: z.string().uuid(),
  requestId: requestIdInput,
  targetModel: targetModelInput,
});

const getInput = z.object({ runId: z.string().uuid() });

const getComparisonInput = z.object({
  orgId: z.string().uuid(),
  runId: z.string().uuid(),
});

const listForRequestInput = z.object({
  orgId: z.string().uuid(),
  requestId: requestIdInput,
});

// ─── Shared selects ───────────────────────────────────────────────────────────

/**
 * Columns returned for a run. Enumerated explicitly (never `select()`) so a
 * future column carrying prompt-derived content cannot leak by simply being
 * added to the table.
 */
const runColumns = {
  id: replayRuns.id,
  orgId: replayRuns.orgId,
  sourceRequestId: replayRuns.sourceRequestId,
  replayRequestId: replayRuns.replayRequestId,
  targetModel: replayRuns.targetModel,
  triggeredBy: replayRuns.triggeredBy,
  status: replayRuns.status,
  failureReason: replayRuns.failureReason,
  fidelity: replayRuns.fidelity,
  createdAt: replayRuns.createdAt,
  completedAt: replayRuns.completedAt,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the author of a captured request within `orgId`.
 *
 * NOT_FOUND both when the request does not exist and when it belongs to a
 * different org — the two cases must be indistinguishable, otherwise probing
 * request ids across orgs would confirm which ones exist. Runs BEFORE the RBAC
 * check for the same reason (matches reports.rerun's `resolveKeyInOrg`).
 */
async function resolveRequestAuthor(
  db: Database,
  orgId: string,
  requestId: string,
): Promise<string> {
  const row = await db
    .select({ userId: usageLogs.userId })
    .from(usageLogs)
    .where(and(eq(usageLogs.requestId, requestId), eq(usageLogs.orgId, orgId)))
    .limit(1)
    .then((r) => r[0]);

  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row.userId;
}

/**
 * Throw FORBIDDEN unless the caller may replay (and thus read) `targetUserId`'s
 * captured content. Applied identically to all three procedures: reading a
 * replay's result is equivalent to reading the decrypted content it came from.
 */
function assertCanReplay(
  perm: Parameters<typeof can>[0],
  orgId: string,
  targetUserId: string,
): void {
  if (!can(perm, { type: "request.replay", orgId, targetUserId })) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

// Gated on ENABLE_EVALUATOR (via evaluatorProcedure), matching apps/gateway,
// where the replay worker is wired inside the same ENABLE_EVALUATOR block as
// the evaluator pipeline — replay depends on the very same captured bodies and
// org eval key. With the flag off there is no worker, so the endpoint must be
// invisible rather than silently accumulating jobs nothing will ever run.
export const replayRouter = router({
  /**
   * Authorise, record and enqueue one replay of a captured request.
   *
   * Order is load-bearing:
   *   1. queue availability (no queue → refuse before writing anything)
   *   2. source lookup       → NOT_FOUND
   *   3. permission          → FORBIDDEN
   *   4. fidelity precheck   → PRECONDITION_FAILED
   *   5. one transaction, behind a per-user advisory lock: count the last
   *      hour's runs → TOO_MANY_REQUESTS, else INSERT the run + its audit row
   *   6. enqueue — only after (5) has committed
   */
  enqueue: evaluatorProcedure
    .input(enqueueInput)
    .mutation(async ({ ctx, input }) => {
      // ctx.replayQueue is undefined when no REDIS_URL is configured. Refusing
      // up front — before any row exists — is the honest answer: inserting a
      // `queued` row nothing can ever pick up would show the user a replay that
      // silently never progresses.
      const queue: ReplayQueue | undefined = ctx.replayQueue;
      if (!queue) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Replay is unavailable: the replay queue is not configured",
        });
      }

      const source = await ctx.db
        .select({
          userId: usageLogs.userId,
          // Presence sentinel for the LEFT JOIN. Testing this rather than
          // `retentionUntil === null` keeps the "was a body captured?" question
          // independent of whether some other column happens to be nullable.
          capturedRequestId: requestBodies.requestId,
          bodyTruncated: requestBodies.bodyTruncated,
          retentionUntil: requestBodies.retentionUntil,
        })
        .from(usageLogs)
        // LEFT JOIN so a request whose body was never captured (capture off at
        // the time, or already wiped) is distinguishable from a request that
        // does not exist — the former is a precondition failure the user can
        // understand, the latter is NOT_FOUND.
        .leftJoin(requestBodies, eq(requestBodies.requestId, usageLogs.requestId))
        .where(
          and(
            eq(usageLogs.requestId, input.requestId),
            eq(usageLogs.orgId, input.orgId),
          ),
        )
        .limit(1)
        .then((r) => r[0]);

      if (!source) throw new TRPCError({ code: "NOT_FOUND" });

      assertCanReplay(ctx.perm, input.orgId, source.userId);

      // ── Fidelity precheck (UX only — apps/gateway's resolveFidelity is the
      //    authority; see the file header). Messages describe the capture, never
      //    its content, so nothing about another user's prompt leaks here.
      if (source.capturedRequestId === null || source.retentionUntil === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This request cannot be replayed: its body was never captured",
        });
      }
      if (source.bodyTruncated === true) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This request cannot be replayed: its captured body was truncated",
        });
      }
      if (source.retentionUntil.getTime() < Date.now()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This request cannot be replayed: its captured body has passed its retention date",
        });
      }

      // ── Rate limit, then persist, then enqueue ────────────────────────────
      // Counting and inserting live in ONE transaction behind a per-user
      // advisory lock. Counting on `ctx.db` before the transaction would not
      // bound spend at all: the only other limiter in front of this endpoint is
      // the global per-user /trpc limiter, whose default is
      // API_TRPC_RPM_LIMIT=2000 per minute, so an authorised caller can fire
      // hundreds of concurrent enqueues, have every one of them read the same
      // pre-limit count, and buy hundreds of paid upstream calls against a
      // ceiling of 20. The limit exists precisely to stop that.
      //
      // `pg_advisory_xact_lock` is transaction-scoped: it releases on commit or
      // rollback, so no path can leak it. Concurrent calls from one user
      // serialise on the same key and each sees its predecessors' committed
      // rows — that relies on READ COMMITTED (the default), where every
      // statement takes a fresh snapshot, so the count *after* the lock sees
      // whatever committed while we waited for it.
      //
      // `hashtext` collisions between two different users cost only some
      // needless serialisation, never a wrong answer: the count itself is
      // always filtered by `triggered_by`.
      //
      // Postgres stays the source of truth deliberately — a Redis counter would
      // be atomic but could drift from the rows it claims to count, and the
      // rows are what actually cost money.
      //
      // The audit row shares this transaction too, so a replay can never exist
      // without the record of who started it.
      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
      const runId = await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${ctx.user.id})::bigint)`,
        );

        const recentRuns = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(replayRuns)
          .where(
            and(
              eq(replayRuns.triggeredBy, ctx.user.id),
              gte(replayRuns.createdAt, windowStart),
            ),
          )
          .then((r) => r[0]?.count ?? 0);

        if (recentRuns >= REPLAY_HOURLY_LIMIT) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: formatValidationKey(
              "validation.custom.replay.hourlyLimitReached",
              { max: REPLAY_HOURLY_LIMIT },
            ),
          });
        }

        const inserted = await tx
          .insert(replayRuns)
          .values({
            orgId: input.orgId,
            sourceRequestId: input.requestId,
            targetModel: input.targetModel,
            triggeredBy: ctx.user.id,
            status: "queued",
          })
          .returning({ id: replayRuns.id })
          .then((r) => r[0]);

        if (!inserted) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not record the replay",
          });
        }

        await writeAudit(tx, {
          actorUserId: ctx.user.id,
          action: REPLAY_AUDIT_ACTION,
          targetType: "usage_log",
          targetId: asAuditTargetId(input.requestId),
          orgId: input.orgId,
          metadata: {
            runId: inserted.id,
            sourceRequestId: input.requestId,
            targetModel: input.targetModel,
            targetUserId: source.userId,
          },
        });

        return inserted.id;
      });

      // Strictly after the commit above — see invariant (1) in the file header.
      try {
        await enqueueReplay(queue, {
          runId,
          orgId: input.orgId,
          sourceRequestId: input.requestId,
          targetModel: input.targetModel,
        });
      } catch (err) {
        // The hand-off failed, so nothing will ever claim this row. Leaving it
        // would strand a `queued` run with no failure reason — indistinguishable
        // in the UI from "still waiting". Remove it and let the user retry,
        // which (correctly) mints a brand new run. Guarded on `status = 'queued'`
        // so a job that actually did land and was already claimed is untouched.
        await ctx.db
          .delete(replayRuns)
          .where(and(eq(replayRuns.id, runId), eq(replayRuns.status, "queued")))
          .catch((cleanupErr: unknown) => {
            ctx.logger.error(
              {
                runId,
                err:
                  cleanupErr instanceof Error
                    ? cleanupErr.message
                    : String(cleanupErr),
              },
              "replay: could not remove the run whose enqueue failed",
            );
          });

        ctx.logger.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "replay: enqueue failed",
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not start the replay. Please try again.",
        });
      }

      return { runId };
    }),

  /**
   * Read one run. Permission is resolved through the run's source request:
   * seeing a replay's outcome is seeing something derived from the source's
   * decrypted content, so `request.replay` applies here exactly as it does to
   * starting one.
   */
  get: evaluatorProcedure.input(getInput).query(async ({ ctx, input }) => {
    const run = await ctx.db
      .select(runColumns)
      .from(replayRuns)
      .where(eq(replayRuns.id, input.runId))
      .limit(1)
      .then((r) => r[0]);

    if (!run) throw new TRPCError({ code: "NOT_FOUND" });

    const authorId = await resolveRequestAuthor(
      ctx.db,
      run.orgId,
      run.sourceRequestId,
    );
    assertCanReplay(ctx.perm, run.orgId, authorId);

    return run;
  }),

  /**
   * The side-by-side comparison for one run: both response bodies decrypted,
   * both sets of metrics, and what may honestly be compared between them.
   *
   * A boundary only. Everything that decides what the operator is allowed to
   * see, and what they are allowed to conclude, lives in
   * `services/replayComparison.ts` — decryption plus two `request_bodies`
   * reads plus comparability is a different kind of work from this file's
   * authorise-and-write procedures, and the rules it encodes deserve to be
   * read (and reviewed) in one piece.
   */
  getComparison: evaluatorProcedure
    .input(getComparisonInput)
    .query(async ({ ctx, input }) =>
      getReplayComparison({
        db: ctx.db,
        env: ctx.env,
        perm: ctx.perm,
        orgId: input.orgId,
        runId: input.runId,
        logger: ctx.logger,
      }),
    ),

  /**
   * Every run for one source request, newest first — the history a comparison
   * page needs. `createdAt` alone is not a total order (two runs started in the
   * same millisecond tie), so `id` breaks the tie; it is arbitrary but stable,
   * which is what keeps the rendered order from shuffling between reads.
   */
  listForRequest: evaluatorProcedure
    .input(listForRequestInput)
    .query(async ({ ctx, input }) => {
      const authorId = await resolveRequestAuthor(
        ctx.db,
        input.orgId,
        input.requestId,
      );
      assertCanReplay(ctx.perm, input.orgId, authorId);

      return ctx.db
        .select(runColumns)
        .from(replayRuns)
        .where(
          and(
            eq(replayRuns.sourceRequestId, input.requestId),
            eq(replayRuns.orgId, input.orgId),
          ),
        )
        .orderBy(desc(replayRuns.createdAt), desc(replayRuns.id));
    }),
});
