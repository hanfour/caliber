import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { organizations, rubrics, usageLogs } from "@caliber/db";
import { can } from "@caliber/auth";
import { rubricSchema, scoreWithRules } from "@caliber/evaluator";
import type { UsageRow } from "@caliber/evaluator";
import { formatValidationKey } from "@caliber/i18n-validation";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";

// ─── Input primitives ─────────────────────────────────────────────────────────

const orgIdInput = z.object({ orgId: z.string().uuid() });
const rubricIdInput = z.object({ rubricId: z.string().uuid() });

// ─── Router ───────────────────────────────────────────────────────────────────

export const rubricsRouter = router({
  /**
   * List all non-deleted rubrics visible to an org:
   *   - platform defaults (org_id IS NULL)
   *   - org's own custom rubrics
   * Requires `rubric.read` on the org.
   */
  list: evaluatorProcedure.input(orgIdInput).query(async ({ ctx, input }) => {
    if (!can(ctx.perm, { type: "rubric.read", orgId: input.orgId })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const rows = await ctx.db
      .select({
        id: rubrics.id,
        orgId: rubrics.orgId,
        name: rubrics.name,
        description: rubrics.description,
        version: rubrics.version,
        isDefault: rubrics.isDefault,
        createdAt: rubrics.createdAt,
        updatedAt: rubrics.updatedAt,
      })
      .from(rubrics)
      .where(
        and(
          isNull(rubrics.deletedAt),
          or(eq(rubrics.orgId, input.orgId), isNull(rubrics.orgId)),
        ),
      )
      .orderBy(desc(rubrics.isDefault), desc(rubrics.createdAt));

    return rows;
  }),

  /**
   * Get a single rubric with its full definition.
   * Platform defaults (orgId = null) are readable by any authenticated user
   * whose permissions include `rubric.read` on at least one org. Org-scoped
   * rubrics are gated by `rubric.read` on that specific org.
   */
  get: evaluatorProcedure.input(rubricIdInput).query(async ({ ctx, input }) => {
    const row = await ctx.db
      .select()
      .from(rubrics)
      .where(and(eq(rubrics.id, input.rubricId), isNull(rubrics.deletedAt)))
      .limit(1)
      .then((r) => r[0]);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    // Platform defaults have no org scope — allow any authenticated user.
    // Org-custom rubrics require rubric.read on the owning org.
    if (
      row.orgId !== null &&
      !can(ctx.perm, { type: "rubric.read", orgId: row.orgId })
    ) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    return row;
  }),

  /**
   * Create a new org-scoped rubric. The `definition` field is validated against
   * `rubricSchema` from `@caliber/evaluator` before insertion.
   * Requires `rubric.create` on the org.
   */
  create: evaluatorProcedure
    .input(
      orgIdInput.extend({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        version: z.string().min(1).max(50),
        definition: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "rubric.create", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const parsed = rubricSchema.safeParse(input.definition);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: formatValidationKey(
            "validation.custom.evaluator.rubricInvalidDefinition",
            { detail: parsed.error.message },
          ),
        });
      }

      const [created] = await ctx.db
        .insert(rubrics)
        .values({
          orgId: input.orgId,
          name: input.name,
          description: input.description ?? null,
          version: input.version,
          definition: parsed.data as Record<string, unknown>,
          isDefault: false,
          createdBy: ctx.user.id,
        })
        .returning({ id: rubrics.id });

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to insert rubric row",
        });
      }

      return { id: created.id };
    }),

  /**
   * Update an existing org-scoped rubric's name, description, version, and/or
   * definition. If `definition` is provided it is re-validated against
   * `rubricSchema`. Requires `rubric.update` on the org + rubric.
   */
  update: evaluatorProcedure
    .input(
      rubricIdInput.extend({
        orgId: z.string().uuid(),
        patch: z.object({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).nullable().optional(),
          version: z.string().min(1).max(50).optional(),
          definition: z.unknown().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "rubric.update",
          orgId: input.orgId,
          rubricId: input.rubricId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (input.patch.name !== undefined) updates.name = input.patch.name;
      if (input.patch.description !== undefined)
        updates.description = input.patch.description;
      if (input.patch.version !== undefined)
        updates.version = input.patch.version;

      if (input.patch.definition !== undefined) {
        const parsed = rubricSchema.safeParse(input.patch.definition);
        if (!parsed.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: formatValidationKey(
              "validation.custom.evaluator.rubricInvalidDefinition",
              { detail: parsed.error.message },
            ),
          });
        }
        updates.definition = parsed.data as Record<string, unknown>;
      }

      await ctx.db
        .update(rubrics)
        .set(updates)
        .where(
          and(
            eq(rubrics.id, input.rubricId),
            eq(rubrics.orgId, input.orgId),
            isNull(rubrics.deletedAt),
          ),
        );

      return { success: true };
    }),

  /**
   * Soft-delete a rubric (sets deletedAt). Cannot delete a rubric that is
   * currently set as the org's active rubric — the caller must call
   * `setActive(null)` first. Requires `rubric.delete` on the org + rubric.
   */
  delete: evaluatorProcedure
    .input(rubricIdInput.extend({ orgId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "rubric.delete",
          orgId: input.orgId,
          rubricId: input.rubricId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const org = await ctx.db
        .select({ rubricId: organizations.rubricId })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1)
        .then((r) => r[0]);

      if (org?.rubricId === input.rubricId) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Cannot delete the org's active rubric. Set a different active rubric first.",
        });
      }

      await ctx.db
        .update(rubrics)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(rubrics.id, input.rubricId),
            eq(rubrics.orgId, input.orgId),
            isNull(rubrics.deletedAt),
          ),
        );

      return { success: true };
    }),

  /**
   * Set (or clear) the org's active rubric by writing `organizations.rubric_id`.
   * Pass `rubricId: null` to clear. The referenced rubric must not be deleted
   * and must be either a platform default or owned by this org.
   * Requires `rubric.update` on the org.
   */
  setActive: evaluatorProcedure
    .input(orgIdInput.extend({ rubricId: z.string().uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "rubric.update",
          orgId: input.orgId,
          rubricId: input.rubricId ?? "",
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      if (input.rubricId !== null) {
        const row = await ctx.db
          .select({ orgId: rubrics.orgId })
          .from(rubrics)
          .where(and(eq(rubrics.id, input.rubricId), isNull(rubrics.deletedAt)))
          .limit(1)
          .then((r) => r[0]);

        if (!row) throw new TRPCError({ code: "NOT_FOUND" });

        // Must be a platform default (orgId=null) or owned by this org
        if (row.orgId !== null && row.orgId !== input.orgId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Rubric belongs to another org",
          });
        }
      }

      await ctx.db
        .update(organizations)
        .set({ rubricId: input.rubricId })
        .where(eq(organizations.id, input.orgId));

      return { success: true };
    }),

  /**
   * Dry-run `scoreWithRules` on the last N days of usage data for a given user
   * without writing any evaluation report. Useful for previewing rubric changes.
   *
   * Body decryption limitation: The API server does not require
   * `CREDENTIAL_ENCRYPTION_KEY` in its environment (it is only mandatory when
   * `ENABLE_GATEWAY=true`, and is optional otherwise). Decrypting sealed request
   * bodies from `request_bodies` requires that key. To avoid a hard dependency
   * on the gateway key, this endpoint scores with usage rows only — `bodyRows`
   * is always empty. Keyword, refusal-rate, client-mix, extended-thinking,
   * tool-diversity, and iteration-count signals will therefore show zero hits.
   * The preview score reflects only threshold-based signals that derive from
   * usage metrics (token counts, cost, model diversity, cache ratios).
   *
   * For a full-fidelity dry-run including body signals, use the gateway's
   * admin evaluation endpoint instead.
   *
   * Requires `rubric.read` on the org.
   */
  dryRun: evaluatorProcedure
    .input(
      orgIdInput.extend({
        rubricId: z.string().uuid(),
        userId: z.string().uuid(),
        days: z.number().int().min(1).max(30).default(7),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "rubric.read", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rubricRow = await ctx.db
        .select()
        .from(rubrics)
        .where(and(eq(rubrics.id, input.rubricId), isNull(rubrics.deletedAt)))
        .limit(1)
        .then((r) => r[0]);

      if (!rubricRow) throw new TRPCError({ code: "NOT_FOUND" });

      const parsedRubric = rubricSchema.parse(rubricRow.definition);

      const periodEnd = new Date();
      const periodStart = new Date(
        periodEnd.getTime() - input.days * 24 * 60 * 60 * 1000,
      );

      const usageRowsRaw = await ctx.db
        .select({
          requestId: usageLogs.requestId,
          requestedModel: usageLogs.requestedModel,
          inputTokens: usageLogs.inputTokens,
          outputTokens: usageLogs.outputTokens,
          cacheReadTokens: usageLogs.cacheReadTokens,
          cacheCreationTokens: usageLogs.cacheCreationTokens,
          totalCost: usageLogs.totalCost,
        })
        .from(usageLogs)
        .where(
          and(
            eq(usageLogs.userId, input.userId),
            gte(usageLogs.createdAt, periodStart),
          ),
        );

      const usageRows: UsageRow[] = usageRowsRaw.map((u) => ({
        requestId: u.requestId,
        requestedModel: u.requestedModel,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        totalCost: u.totalCost,
      }));

      // bodyRows is always empty — see JSDoc above for rationale.
      const report = scoreWithRules({
        rubric: parsedRubric,
        usageRows,
        bodyRows: [],
      });

      return {
        rubricId: input.rubricId,
        userId: input.userId,
        periodStart,
        periodEnd,
        usageOnly: true,
        preview: report,
      };
    }),
});
