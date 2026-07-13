import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  apiKeys,
  organizationMembers,
  organizations,
  requestBodyFacets,
  rubrics,
  usageLogs,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import { can } from "@caliber/auth";
import type { UserPermissions } from "@caliber/auth";
import { rubricSchema, scoreWithRules } from "@caliber/evaluator";
import type { BodyRow, UsageRow } from "@caliber/evaluator";
import { formatValidationKey } from "@caliber/i18n-validation";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { ensureGatewayEnabled } from "./_shared.js";
import { writeAudit } from "../../services/audit.js";

// ─── Input primitives ─────────────────────────────────────────────────────────

const orgIdInput = z.object({ orgId: z.string().uuid() });
const rubricIdInput = z.object({ rubricId: z.string().uuid() });
const apiKeyIdInput = z.object({ apiKeyId: z.string().uuid() });

// ─── Key resolution helper ────────────────────────────────────────────────────

/**
 * Resolve an api_key for a key-scoped rubric operation. Throws NOT_FOUND
 * (never FORBIDDEN) when:
 *   - the key is missing
 *   - the caller is neither the key owner nor an org_admin of key.orgId
 *   - the key is revoked
 *
 * Anti-enumeration: an unauthorized caller sees NOT_FOUND before learning
 * whether the key is active or revoked, so peer members and cross-org admins
 * cannot confirm a key's existence via the rubric surface.
 */
async function resolveKeyForRubric(
  db: Database,
  apiKeyId: string,
  perm: UserPermissions,
  action: "rubric.read_key" | "rubric.author_key" | "rubric.delete_key",
): Promise<{ id: string; userId: string; orgId: string; revokedAt: Date | null }> {
  const [key] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      orgId: apiKeys.orgId,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);

  if (!key) throw new TRPCError({ code: "NOT_FOUND" });

  // Anti-enumeration: NOT_FOUND even on found-but-unauthorized (BEFORE revoke
  // check so a peer can't distinguish "key exists + revoked" from "not found").
  if (
    !can(perm, {
      type: action,
      apiKeyId: key.id,
      orgId: key.orgId,
      ownerUserId: key.userId,
    })
  ) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  // Authorized callers see NOT_FOUND on revoked keys for read/author actions:
  // prevents reading or authoring rubrics on keys that can no longer issue
  // requests. deleteForKey is exempt — owners and org_admins must be able to
  // clean up a rubric attached to a revoked key (spec §6).
  // Anti-enumeration ordering is preserved: the can() check above fires BEFORE
  // this check, so an unauthorized caller on a revoked key still sees NOT_FOUND
  // regardless of action, and cannot learn whether the key is active or revoked.
  if (key.revokedAt !== null && action !== "rubric.delete_key") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  return key;
}

async function assertUserIsOrgMember(
  db: Database,
  userId: string,
  orgId: string,
): Promise<void> {
  const [membership] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Target user is not a member of this organization",
    });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const rubricsRouter = router({
  /**
   * List all non-deleted org-scoped rubrics visible to an org (excludes
   * key-scoped rubrics — those are invisible to the org picker). Returns:
   *   - platform defaults (org_id IS NULL, api_key_id IS NULL)
   *   - org's own custom rubrics (api_key_id IS NULL)
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
          isNull(rubrics.apiKeyId),
          or(eq(rubrics.orgId, input.orgId), isNull(rubrics.orgId)),
        ),
      )
      .orderBy(desc(rubrics.isDefault), desc(rubrics.createdAt));

    return rows;
  }),

  /**
   * Get a single org-scoped rubric with its full definition. Key-scoped
   * rubrics (apiKeyId IS NOT NULL) return NOT_FOUND — use `getForKey` instead.
   * Platform defaults (orgId = null) are readable by any authenticated user
   * whose permissions include `rubric.read` on at least one org. Org-scoped
   * rubrics are gated by `rubric.read` on that specific org.
   */
  get: evaluatorProcedure.input(rubricIdInput).query(async ({ ctx, input }) => {
    const row = await ctx.db
      .select()
      .from(rubrics)
      .where(
        and(
          eq(rubrics.id, input.rubricId),
          isNull(rubrics.deletedAt),
          isNull(rubrics.apiKeyId),
        ),
      )
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
   * definition. Key-scoped rubrics (apiKeyId IS NOT NULL) are excluded — use
   * `upsertForKey` instead. If `definition` is provided it is re-validated.
   * Requires `rubric.update` on the org + rubric.
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
            isNull(rubrics.apiKeyId),
          ),
        );

      return { success: true };
    }),

  /**
   * Soft-delete a rubric (sets deletedAt). Key-scoped rubrics (apiKeyId IS NOT
   * NULL) are excluded — use `deleteForKey` instead. Cannot delete a rubric
   * that is currently set as the org's active rubric.
   * Requires `rubric.delete` on the org + rubric.
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
            isNull(rubrics.apiKeyId),
          ),
        );

      return { success: true };
    }),

  /**
   * Set (or clear) the org's active rubric by writing `organizations.rubric_id`.
   * Pass `rubricId: null` to clear. The referenced rubric must not be deleted,
   * must be either a platform default or owned by this org, and must NOT be
   * key-scoped (apiKeyId IS NOT NULL → FORBIDDEN).
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
          .select({ orgId: rubrics.orgId, apiKeyId: rubrics.apiKeyId })
          .from(rubrics)
          .where(and(eq(rubrics.id, input.rubricId), isNull(rubrics.deletedAt)))
          .limit(1)
          .then((r) => r[0]);

        if (!row) throw new TRPCError({ code: "NOT_FOUND" });

        // Key-scoped rubrics cannot be pinned as the org's active rubric
        if (row.apiKeyId !== null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A key-scoped rubric cannot be set as the org's active rubric",
          });
        }

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
   * without writing any evaluation report. Key-scoped rubrics (apiKeyId IS NOT
   * NULL) return NOT_FOUND — the org_admin cannot preview a key's private rubric.
   * Requires `rubric.read` on the org.
   *
   * Body decryption limitation: The API server does not require
   * `CREDENTIAL_ENCRYPTION_KEY` in its environment (it is only mandatory when
   * `ENABLE_GATEWAY=true`, and is optional otherwise). Decrypting sealed request
   * bodies from `request_bodies` requires that key. To avoid a hard dependency
   * on the gateway key, this endpoint scores with usage rows only — `bodyRows`
   * is always empty. Keyword, refusal-rate, client-mix, extended-thinking,
   * tool-diversity, and iteration-count signals will therefore show zero hits.
   * The preview score reflects only threshold-based signals that derive from
   * usage metrics (token counts, cost, model diversity, cache ratios) plus,
   * as of v2, facet-based signals (`facet_*`) — `request_body_facets` columns
   * are plaintext, so they carry no `CREDENTIAL_ENCRYPTION_KEY` dependency and
   * are loaded for the same window as `usageRows`. Continuous v2 rubrics that
   * rely on facet signals will therefore preview real (non-zero) scores here.
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

      await assertUserIsOrgMember(ctx.db, input.userId, input.orgId);

      const rubricRow = await ctx.db
        .select()
        .from(rubrics)
        .where(
          and(
            eq(rubrics.id, input.rubricId),
            isNull(rubrics.deletedAt),
            isNull(rubrics.apiKeyId),
            or(isNull(rubrics.orgId), eq(rubrics.orgId, input.orgId)),
          ),
        )
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
            eq(usageLogs.orgId, input.orgId),
            eq(usageLogs.userId, input.userId),
            gte(usageLogs.createdAt, periodStart),
            lt(usageLogs.createdAt, periodEnd),
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

      // Facet rows are plaintext (no CREDENTIAL_ENCRYPTION_KEY dependency), so
      // dry-run can load them for the same requestIds even though bodyRows
      // stays empty — see JSDoc above.
      const requestIds = usageRows.map((u) => u.requestId);
      const facetRows =
        requestIds.length === 0
          ? []
          : await ctx.db
              .select({
                sessionType: requestBodyFacets.sessionType,
                outcome: requestBodyFacets.outcome,
                claudeHelpfulness: requestBodyFacets.claudeHelpfulness,
                frictionCount: requestBodyFacets.frictionCount,
                bugsCaughtCount: requestBodyFacets.bugsCaughtCount,
                codexErrorsCount: requestBodyFacets.codexErrorsCount,
                userSatisfaction: requestBodyFacets.userSatisfaction,
              })
              .from(requestBodyFacets)
              .where(inArray(requestBodyFacets.requestId, requestIds));

      // bodyRows is always empty — see JSDoc above for rationale.
      const bodyRows: BodyRow[] = [];
      const report = scoreWithRules({
        rubric: parsedRubric,
        usageRows,
        bodyRows,
        facetRows,
      });

      return {
        rubricId: input.rubricId,
        userId: input.userId,
        periodStart,
        periodEnd,
        usageOnly: bodyRows.length === 0,
        preview: report,
      };
    }),

  // ─── Key-scoped rubric procedures ─────────────────────────────────────────────

  /**
   * Get the live rubric assigned to a specific api key, or null if none is set.
   * Returns NOT_FOUND when the key is missing, revoked, or the caller is
   * neither the key owner nor an org_admin of key.orgId (anti-enumeration).
   * Returns null (not a 404) when the key is valid but has no rubric assigned.
   *
   * Requires ENABLE_GATEWAY + `rubric.read_key` (owner or org_admin).
   */
  getForKey: evaluatorProcedure
    .input(apiKeyIdInput)
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const key = await resolveKeyForRubric(
        ctx.db,
        input.apiKeyId,
        ctx.perm,
        "rubric.read_key",
      );

      const row = await ctx.db
        .select()
        .from(rubrics)
        .where(
          and(eq(rubrics.apiKeyId, key.id), isNull(rubrics.deletedAt)),
        )
        .limit(1)
        .then((r) => r[0] ?? null);

      return row;
    }),

  /**
   * Create or update the rubric assigned to a specific api key. Server-forces
   * `apiKeyId`, `orgId`, `isDefault = false`, and `createdBy` (on insert).
   * Uses a partial-unique-index upsert so a soft-deleted prior row does not
   * conflict with a new insert.
   *
   * Returns NOT_FOUND when the key is missing, revoked, or the caller is
   * neither the key owner nor an org_admin.
   * Returns BAD_REQUEST when `definition` fails `rubricSchema` validation.
   *
   * Requires ENABLE_GATEWAY + `rubric.author_key` (owner or org_admin).
   */
  upsertForKey: evaluatorProcedure
    .input(
      apiKeyIdInput.extend({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        version: z.string().min(1).max(50),
        definition: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const key = await resolveKeyForRubric(
        ctx.db,
        input.apiKeyId,
        ctx.perm,
        "rubric.author_key",
      );

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

      // Upsert onto the live partial-unique slot:
      //   ON CONFLICT (api_key_id) WHERE api_key_id IS NOT NULL AND deleted_at IS NULL
      // A soft-deleted prior row does not occupy the slot, so a new INSERT is
      // issued instead. Concurrent double-create is handled by the DB's conflict
      // resolution — only one row wins the live slot.
      const [upserted] = await ctx.db
        .insert(rubrics)
        .values({
          orgId: key.orgId,
          apiKeyId: key.id,
          name: input.name,
          description: input.description ?? null,
          version: input.version,
          definition: parsed.data as Record<string, unknown>,
          isDefault: false,
          createdBy: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: rubrics.apiKeyId,
          targetWhere: sql`api_key_id IS NOT NULL AND deleted_at IS NULL`,
          set: {
            name: input.name,
            description: input.description ?? null,
            version: input.version,
            definition: parsed.data as Record<string, unknown>,
            updatedAt: new Date(),
          },
        })
        .returning({ id: rubrics.id });

      if (!upserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to upsert key rubric row",
        });
      }

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "rubric.key_set",
        targetType: "api_key",
        targetId: key.id,
        orgId: key.orgId,
        metadata: { rubricId: upserted.id },
      });

      return { id: upserted.id };
    }),

  /**
   * Soft-delete the rubric assigned to a specific api key. A no-op if the key
   * has no live rubric. Returns NOT_FOUND when the key is missing, revoked, or
   * the caller is neither the key owner nor an org_admin.
   *
   * Requires ENABLE_GATEWAY + `rubric.delete_key` (owner or org_admin).
   */
  deleteForKey: evaluatorProcedure
    .input(apiKeyIdInput)
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const key = await resolveKeyForRubric(
        ctx.db,
        input.apiKeyId,
        ctx.perm,
        "rubric.delete_key",
      );

      await ctx.db
        .update(rubrics)
        .set({ deletedAt: new Date() })
        .where(
          and(eq(rubrics.apiKeyId, key.id), isNull(rubrics.deletedAt)),
        );

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "rubric.key_cleared",
        targetType: "api_key",
        targetId: key.id,
        orgId: key.orgId,
        metadata: {},
      });

      return { success: true };
    }),
});
