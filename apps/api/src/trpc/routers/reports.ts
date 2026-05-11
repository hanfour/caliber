import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  evaluationReports,
  gdprDeleteRequests,
  organizationMembers,
  requestBodies,
  teamMembers,
  usageLogs,
} from "@caliber/db";
import { can } from "@caliber/auth";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { notifyGdprRequested } from "../../services/gdprNotifications.js";
import { getFacetSummary } from "../../services/facetSummary.js";

// ─── Evaluator queue constants (duplicated from apps/gateway to avoid cross-package import) ──
// TODO: extract to a shared @caliber/queue package to eliminate this duplication.
const EVALUATOR_QUEUE_NAME = "evaluator";
const EVALUATOR_QUEUE_PREFIX = "caliber:gw";

// Minimal Queue interface — matches the BullMQ Queue surface we need.
// When ctx.evaluatorQueue is undefined (test mode / queue not wired), rerun
// returns { enqueued: 0, targets: N, testMode: true } instead of calling add().
interface EvaluatorQueue {
  add(
    name: string,
    data: EvaluatorJobPayload,
    opts?: { jobId?: string },
  ): Promise<unknown>;
}

interface EvaluatorJobPayload {
  orgId: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  periodType: string;
  triggeredBy: string;
  triggeredByUser: string;
}

export { EVALUATOR_QUEUE_NAME, EVALUATOR_QUEUE_PREFIX };
export type { EvaluatorQueue };

// ─── Input primitives ─────────────────────────────────────────────────────────

const dateRange = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// ─── LLM redaction ────────────────────────────────────────────────────────────

type EvaluationReportRow = typeof evaluationReports.$inferSelect;

function redactLlm(
  row: EvaluationReportRow,
  canSeeLlm: boolean,
): EvaluationReportRow {
  if (canSeeLlm) return row;
  return {
    ...row,
    llmNarrative: null,
    llmEvidence: null,
    llmModel: null,
    llmCalledAt: null,
    llmCostUsd: null,
    llmUpstreamAccountId: null,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const reportsRouter = router({
  /**
   * Returns the caller's most recent evaluation report (by periodStart desc).
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnLatest: evaluatorProcedure.query(async ({ ctx }) => {
    if (!can(ctx.perm, { type: "report.read_own" })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const row = await ctx.db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, ctx.user.id))
      .orderBy(desc(evaluationReports.periodStart))
      .limit(1)
      .then((r) => r[0] ?? null);

    return row;
  }),

  /**
   * Returns all of the caller's reports whose periodStart falls within [from, to].
   * Results are ordered by periodStart desc.
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnRange: evaluatorProcedure
    .input(dateRange)
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.userId, ctx.user.id),
            gte(evaluationReports.periodStart, new Date(input.from)),
            lte(evaluationReports.periodStart, new Date(input.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      return rows;
    }),

  /**
   * Returns a specific user's reports within the given date range.
   * LLM fields are visible only to the report subject or an org_admin.
   * Requires `report.read_user` — granted when:
   *   - targetUserId === caller's own id (self-access), OR
   *   - caller is org_admin for the org.
   */
  getUser: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        userId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.userId, input.userId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      const canSeeLlm =
        input.userId === ctx.user.id ||
        can(ctx.perm, { type: "report.read_org", orgId: input.orgId });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns the facet-extraction aggregate for one (org, user, period) window.
   * Surfaces session-type distribution, success rate, and the four
   * count-style metrics that the rule-engine signals consume. Used by the
   * report-page drill-down (Plan 4C follow-up #3).
   *
   * Same RBAC as `getUser`: `report.read_user`. Returns the empty summary
   * (zero rows, all null aggregates) when no facet rows exist for the
   * window — never throws on empty input.
   */
  facetSummary: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        userId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      return getFacetSummary(
        ctx.db,
        input.orgId,
        input.userId,
        new Date(input.range.from),
        new Date(input.range.to),
      );
    }),

  /**
   * Returns aggregate-level team reports within the given date range.
   * LLM fields are visible only to org_admins; team_managers see them redacted.
   * Requires `report.read_team` — granted when caller is team_manager or org_admin.
   */
  getTeam: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        teamId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_team",
          orgId: input.orgId,
          teamId: input.teamId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.teamId, input.teamId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Only org_admins see LLM details — team_managers get them redacted.
      const canSeeLlm = can(ctx.perm, {
        type: "report.read_org",
        orgId: input.orgId,
      });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns all org-wide reports within the given date range.
   * Caller must be org_admin (report.read_org), and therefore always sees
   * full LLM fields — no redaction applied at this scope.
   */
  getOrg: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_org", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Caller is org_admin (enforced above) — full LLM fields returned.
      return rows;
    }),

  // ─── Mutation endpoints ───────────────────────────────────────────────────────

  /**
   * Enqueue evaluator jobs for the given scope (user/team/org).
   * Window ≤ 30 days enforced. RBAC: `report.rerun` (org_admin).
   *
   * Production queue wiring is deferred to Task 6.4b. When ctx.evaluatorQueue
   * is undefined (test mode / not yet wired), returns { enqueued: 0, targets: N,
   * testMode: true } without calling BullMQ.
   */
  rerun: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        scope: z.enum(["user", "team", "org"]),
        targetId: z.string().uuid(),
        periodStart: z.string().datetime(),
        periodEnd: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const startMs = new Date(input.periodStart).getTime();
      const endMs = new Date(input.periodEnd).getTime();
      const WINDOW_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

      if (endMs <= startMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "periodEnd must be after periodStart",
        });
      }
      if (endMs - startMs > WINDOW_LIMIT_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Window exceeds 30 days",
        });
      }

      // RBAC: user scope checks target user; team/org scope reuses org_admin gate
      if (input.scope === "user") {
        if (
          !can(ctx.perm, {
            type: "report.rerun",
            orgId: input.orgId,
            targetUserId: input.targetId,
            periodStart: input.periodStart,
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
      } else {
        if (
          !can(ctx.perm, {
            type: "report.rerun",
            orgId: input.orgId,
            targetUserId: ctx.user.id,
            periodStart: input.periodStart,
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
      }

      // Enumerate target users by scope
      const userIds: string[] = [];
      if (input.scope === "user") {
        userIds.push(input.targetId);
      } else if (input.scope === "team") {
        const members = await ctx.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, input.targetId));
        userIds.push(...members.map((m) => m.userId));
      } else {
        const members = await ctx.db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.orgId, input.orgId));
        userIds.push(...members.map((m) => m.userId));
      }

      // ctx.evaluatorQueue is undefined when ENABLE_EVALUATOR=false or no
      // REDIS_URL is configured (e.g. test mode). Falls back gracefully.
      const queue = ctx.evaluatorQueue;

      if (!queue) {
        return {
          enqueued: 0,
          targets: userIds.length,
          testMode: true as const,
        };
      }

      let enqueued = 0;
      for (const uid of userIds) {
        try {
          await queue.add(
            EVALUATOR_QUEUE_NAME,
            {
              orgId: input.orgId,
              userId: uid,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              periodType: "daily",
              triggeredBy: "admin_rerun",
              triggeredByUser: ctx.user.id,
            },
            { jobId: `${uid}:${input.periodStart}:daily` },
          );
          enqueued += 1;
        } catch {
          // Dedup collision — expected, not an error
        }
      }

      return { enqueued, targets: userIds.length, testMode: false as const };
    }),

  /**
   * Generate a JSON dump of the caller's data (reports + body metadata).
   * Bodies are listed by requestId only — no decrypted content, since the api
   * server does not hold CREDENTIAL_ENCRYPTION_KEY in all environments.
   * Satisfies GDPR "right to access" without cross-cutting crypto.
   * Requires `report.export_own` (always-true for authenticated users).
   */
  exportOwn: evaluatorProcedure.query(async ({ ctx }) => {
    if (!can(ctx.perm, { type: "report.export_own" })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const reports = await ctx.db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, ctx.user.id))
      .orderBy(desc(evaluationReports.periodStart));

    // List body request metadata only — NOT decrypted body content
    const bodies = await ctx.db
      .select({
        requestId: requestBodies.requestId,
        capturedAt: requestBodies.capturedAt,
        retentionUntil: requestBodies.retentionUntil,
        bodyTruncated: requestBodies.bodyTruncated,
        toolResultTruncated: requestBodies.toolResultTruncated,
      })
      .from(requestBodies)
      .innerJoin(usageLogs, eq(usageLogs.requestId, requestBodies.requestId))
      .where(eq(usageLogs.userId, ctx.user.id));

    return {
      userId: ctx.user.id,
      exportedAt: new Date(),
      reports,
      bodies,
      note: "Body content is encrypted at rest. Contact your administrator to request decrypted exports.",
    };
  }),

  /**
   * Insert a pending GDPR delete request (requires admin approval to execute).
   * scope: "bodies" deletes request bodies only; "bodies_and_reports" also
   * removes evaluation reports. Requires `report.delete_own` (always-true).
   * Emits a structured log + audit log for observability and compliance.
   */
  deleteOwn: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        scope: z.enum(["bodies", "bodies_and_reports"]),
        reason: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.delete_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [created] = await ctx.db
        .insert(gdprDeleteRequests)
        .values({
          orgId: input.orgId,
          userId: ctx.user.id,
          requestedByUserId: ctx.user.id,
          reason: input.reason ?? null,
          scope: input.scope,
        })
        .returning({ id: gdprDeleteRequests.id });

      // Emit structured log + audit log for observability and compliance
      await notifyGdprRequested({
        db: ctx.db,
        orgId: input.orgId,
        userId: ctx.user.id,
        requestedByUserId: ctx.user.id,
        requestId: created!.id,
        scope: input.scope,
        reason: input.reason ?? null,
        logger: ctx.logger,
      });

      return { id: created!.id };
    }),

  /**
   * Approve a pending GDPR delete request.
   * Sets approvedAt + approvedByUserId. Actual data deletion is performed by a
   * background worker that polls for approved requests (out of scope here).
   * RBAC: reuses `report.rerun` as the org_admin gate (no dedicated action yet).
   */
  approveDelete: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        requestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.rerun",
          orgId: input.orgId,
          targetUserId: ctx.user.id,
          periodStart: "1970-01-01",
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(gdprDeleteRequests)
        .set({
          approvedAt: new Date(),
          approvedByUserId: ctx.user.id,
        })
        .where(
          and(
            eq(gdprDeleteRequests.id, input.requestId),
            eq(gdprDeleteRequests.orgId, input.orgId),
          ),
        );

      return { success: true };
    }),

  /**
   * Reject a pending GDPR delete request with a mandatory reason.
   * Sets rejectedAt + rejectedReason. Same org_admin RBAC as approveDelete.
   */
  rejectDelete: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        requestId: z.string().uuid(),
        reason: z.string().max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.rerun",
          orgId: input.orgId,
          targetUserId: ctx.user.id,
          periodStart: "1970-01-01",
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(gdprDeleteRequests)
        .set({
          rejectedAt: new Date(),
          rejectedReason: input.reason,
        })
        .where(
          and(
            eq(gdprDeleteRequests.id, input.requestId),
            eq(gdprDeleteRequests.orgId, input.orgId),
          ),
        );

      return { success: true };
    }),
});
