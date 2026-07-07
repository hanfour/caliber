import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { organizations, auditLogs, requestBodies, rubrics } from "@caliber/db";
import { can } from "@caliber/auth";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { provisionLlmEvalKey } from "../../services/llmEvalKeyProvisioning.js";

const orgIdInput = z.object({ orgId: z.string().uuid() });

// Centralizes the API_KEY_HASH_PEPPER presence check (mirrors apiKeys.ts /
// devices.ts). The env schema requires this when the gateway is enabled, so
// reaching the throw branch indicates a misconfiguration upstream — guard so
// we never call provisionLlmEvalKey with undefined.
function requirePepper(env: { API_KEY_HASH_PEPPER?: string }): string {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "API_KEY_HASH_PEPPER not configured",
    });
  }
  return pepper;
}

const settingsPatch = z.object({
  contentCaptureEnabled: z.boolean().optional(),
  retentionDaysOverride: z.number().int().min(1).max(365).nullable().optional(),
  llmEvalEnabled: z.boolean().optional(),
  llmEvalAccountId: z.string().uuid().nullable().optional(),
  llmEvalModel: z.string().nullable().optional(),
  captureThinking: z.boolean().optional(),
  rubricId: z.string().uuid().nullable().optional(),
  leaderboardEnabled: z.boolean().optional(),

  // ── Plan 4C: cost budget + facet ──────────────────────────────────────────
  llmFacetEnabled: z.boolean().optional(),
  llmFacetModel: z
    .enum(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"])
    .nullable()
    .optional(),
  llmMonthlyBudgetUsd: z.number().min(0).max(100_000).nullable().optional(),
  llmBudgetOverageBehavior: z.enum(["degrade", "halt"]).optional(),
});

export const contentCaptureRouter = router({
  getSettings: evaluatorProcedure
    .input(orgIdInput)
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.read", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [org] = await ctx.db
        .select({
          contentCaptureEnabled: organizations.contentCaptureEnabled,
          contentCaptureEnabledAt: organizations.contentCaptureEnabledAt,
          contentCaptureEnabledBy: organizations.contentCaptureEnabledBy,
          retentionDaysOverride: organizations.retentionDaysOverride,
          llmEvalEnabled: organizations.llmEvalEnabled,
          llmEvalAccountId: organizations.llmEvalAccountId,
          llmEvalModel: organizations.llmEvalModel,
          captureThinking: organizations.captureThinking,
          rubricId: organizations.rubricId,
          leaderboardEnabled: organizations.leaderboardEnabled,
          // Plan 4C — cost budget + facet
          llmFacetEnabled: organizations.llmFacetEnabled,
          llmFacetModel: organizations.llmFacetModel,
          llmMonthlyBudgetUsd: organizations.llmMonthlyBudgetUsd,
          llmBudgetOverageBehavior: organizations.llmBudgetOverageBehavior,
          llmHaltedUntilMonthEnd: organizations.llmHaltedUntilMonthEnd,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!org) throw new TRPCError({ code: "NOT_FOUND" });
      return org;
    }),

  setSettings: evaluatorProcedure
    .input(orgIdInput.extend({ patch: settingsPatch }))
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.toggle", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // Fetch current state to detect first-enable transition AND to compute
      // the resulting row for cross-field validation (Plan 4C).
      const [prev] = await ctx.db
        .select({
          contentCaptureEnabled: organizations.contentCaptureEnabled,
          contentCaptureEnabledAt: organizations.contentCaptureEnabledAt,
          llmEvalEnabled: organizations.llmEvalEnabled,
          llmFacetEnabled: organizations.llmFacetEnabled,
          llmFacetModel: organizations.llmFacetModel,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!prev) throw new TRPCError({ code: "NOT_FOUND" });

      // Plan 4C cross-field validation (defence-in-depth — the form has its
      // own client-side check, but we must reject bad combos here too).
      // Validate the *resulting* row, not just the patch, since the patch
      // may enable facet while assuming eval is already on.
      const nextEvalEnabled = input.patch.llmEvalEnabled ?? prev.llmEvalEnabled;
      const nextFacetEnabled =
        input.patch.llmFacetEnabled ?? prev.llmFacetEnabled;
      const nextFacetModel =
        input.patch.llmFacetModel === undefined
          ? prev.llmFacetModel
          : input.patch.llmFacetModel;

      if (nextFacetEnabled && !nextEvalEnabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Facet extraction requires LLM evaluation to be enabled first",
        });
      }
      if (nextFacetEnabled && !nextFacetModel) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a facet model when enabling facet extraction",
        });
      }

      // Backstop: reject key-scoped rubrics from being pinned as org-active.
      // The resolver's org-branch isNull(apiKeyId) is the final guard; this
      // blocks the second writer of organizations.rubricId at the API layer.
      if (input.patch.rubricId != null) {
        const rubricRow = await ctx.db
          .select({ apiKeyId: rubrics.apiKeyId })
          .from(rubrics)
          .where(eq(rubrics.id, input.patch.rubricId))
          .limit(1)
          .then((r) => r[0]);
        if (rubricRow?.apiKeyId != null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "rubric is key-scoped",
          });
        }
      }

      const turningOn =
        input.patch.contentCaptureEnabled === true &&
        prev.contentCaptureEnabled === false;

      const turningOnEval =
        input.patch.llmEvalEnabled === true && prev.llmEvalEnabled === false;

      const now = new Date();
      const updates: Record<string, unknown> = { ...input.patch };
      // Drizzle's `decimal` column expects a string at the type level. The Zod
      // schema accepts numbers from the UI, so coerce here.
      if (typeof input.patch.llmMonthlyBudgetUsd === "number") {
        updates.llmMonthlyBudgetUsd = String(input.patch.llmMonthlyBudgetUsd);
      }
      if (turningOn) {
        updates.contentCaptureEnabledAt = now;
        updates.contentCaptureEnabledBy = ctx.user.id;
      }

      await ctx.db
        .update(organizations)
        .set(updates)
        .where(eq(organizations.id, input.orgId));

      if (turningOnEval) {
        await provisionLlmEvalKey({
          db: ctx.db,
          redis: ctx.redis,
          orgId: input.orgId,
          apiKeyHashPepper: requirePepper(ctx.env),
        });
      }

      if (turningOn) {
        await ctx.db.insert(auditLogs).values({
          actorUserId: ctx.user.id,
          action: "content_capture.enabled",
          targetType: "organization",
          targetId: input.orgId,
          orgId: input.orgId,
          metadata: { patch: input.patch },
        });
      }

      return { success: true };
    }),

  wipeExistingCaptures: evaluatorProcedure
    .input(orgIdInput)
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.toggle", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(requestBodies)
        .set({ retentionUntil: sql`now()` })
        .where(eq(requestBodies.orgId, input.orgId));

      await ctx.db.insert(auditLogs).values({
        actorUserId: ctx.user.id,
        action: "content_capture.wiped",
        targetType: "organization",
        targetId: input.orgId,
        orgId: input.orgId,
        metadata: {},
      });

      return { success: true };
    }),
});
