import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { evaluationReports, organizationMembers } from "@caliber/db";
import { can } from "@caliber/auth";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { getCostSummary } from "../../services/evaluatorCost.js";

export const evaluatorRouter = router({
  /**
   * Returns cron health + coverage stats for an org.
   * Requires `evaluator.read_status` on the org.
   *
   * Note: queueDepth and dlqCount are not included here because the api
   * server does not hold a direct Redis BullMQ connection. Those metrics
   * are exposed via the Prometheus endpoint on the gateway instead.
   */
  status: evaluatorProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "evaluator.read_status", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // Most recent evaluation report for this org
      const lastReport = await ctx.db
        .select({
          createdAt: evaluationReports.createdAt,
          periodStart: evaluationReports.periodStart,
        })
        .from(evaluationReports)
        .where(eq(evaluationReports.orgId, input.orgId))
        .orderBy(desc(evaluationReports.createdAt))
        .limit(1)
        .then((r) => r[0]);

      // Total active members in the org (coverage denominator)
      const memberCount = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, input.orgId))
        .then((r) => r[0]?.count ?? 0);

      // Reports written in the last 24 hours (coverage numerator)
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentReports = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            gte(evaluationReports.createdAt, dayAgo),
          ),
        )
        .then((r) => r[0]?.count ?? 0);

      // Next scheduled cron run: 00:05 UTC on the next calendar day
      // (or today if the cron has not yet fired at 00:05 today).
      const now = new Date();
      const todayFiredAlready =
        now.getUTCHours() > 0 ||
        (now.getUTCHours() === 0 && now.getUTCMinutes() >= 5);
      const nextCron = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + (todayFiredAlready ? 1 : 0),
          0,
          5,
          0,
          0,
        ),
      );

      return {
        lastCronAt: lastReport?.createdAt ?? null,
        lastPeriodStart: lastReport?.periodStart ?? null,
        nextCronAt: nextCron,
        memberCount,
        reportsWrittenLast24h: recentReports,
        coveragePct: memberCount > 0 ? (recentReports / memberCount) * 100 : 0,
      };
    }),

  /**
   * Returns the LLM cost summary for an org: current-month spend, budget,
   * projected end-of-month, breakdowns by event type/model, 6-month history,
   * and the warning/halted flags. Requires `evaluator.view_cost` on the org.
   */
  costSummary: evaluatorProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "evaluator.view_cost", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return getCostSummary(ctx.db, input.orgId);
    }),
});
