import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  accountGroups,
  accountGroupMembers,
  upstreamAccounts,
  ACCOUNT_GROUP_STATUS_VALUES,
} from "@aide/db";
import { can } from "@aide/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { writeAudit } from "../../services/audit.js";

// API-key migration plan Phase 3 #1 — admin CRUD for account groups, the
// scheduler-side abstraction that load-balances upstream accounts under a
// shared name + rate cap.  Schema (`packages/db/src/schema/accountGroups.ts`)
// has been live since Plan 4A; until now membership was managed via raw SQL
// only.  This router exposes the full surface so org admins can compose
// pools (e.g. several OpenAI project keys with different priorities) from
// the UI.

const uuid = z.string().uuid();
const platformEnum = z.enum(["anthropic", "openai"]);
const groupStatusEnum = z.enum(ACCOUNT_GROUP_STATUS_VALUES);

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Postgres unique / PK violation SQLSTATE — pg passes through the
// underlying constraint name as `err.constraint`. Matching by SQLSTATE
// instead of constraint-name substring keeps the mapping resilient if
// drizzle-kit ever renames a constraint on regeneration.
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  return e.constraint === constraint;
}

const CONSTRAINT_GROUP_NAME = "account_groups_org_name_unique";
const CONSTRAINT_MEMBER_PK = "account_group_members_account_id_group_id_pk";

export const accountGroupsRouter = router({
  list: permissionProcedure(z.object({ orgId: uuid }), (_, input) => ({
    type: "account_group.read",
    orgId: input.orgId,
  })).query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    return ctx.db
      .select({
        id: accountGroups.id,
        orgId: accountGroups.orgId,
        name: accountGroups.name,
        description: accountGroups.description,
        platform: accountGroups.platform,
        rateMultiplier: accountGroups.rateMultiplier,
        isExclusive: accountGroups.isExclusive,
        status: accountGroups.status,
        createdAt: accountGroups.createdAt,
        updatedAt: accountGroups.updatedAt,
      })
      .from(accountGroups)
      .where(
        and(
          eq(accountGroups.orgId, input.orgId),
          isNull(accountGroups.deletedAt),
        ),
      );
  }),

  get: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [group] = await ctx.db
        .select()
        .from(accountGroups)
        .where(
          and(eq(accountGroups.id, input.id), isNull(accountGroups.deletedAt)),
        )
        .limit(1);
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      // Don't leak existence — same NOT_FOUND-not-FORBIDDEN pattern the
      // accounts router uses.
      if (!can(ctx.perm, { type: "account_group.read", orgId: group.orgId })) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // The membership row's FK cascades on hard-delete of the account, but
      // soft-deleted accounts (`deletedAt IS NOT NULL`) still return rows
      // here. Surface `accountDeletedAt` so the UI can render a "tombstoned"
      // affordance instead of pretending the account is healthy. Scheduler
      // already skips deleted accounts at runtime via `selectAccount`.
      const members = await ctx.db
        .select({
          accountId: accountGroupMembers.accountId,
          priority: accountGroupMembers.priority,
          addedAt: accountGroupMembers.createdAt,
          accountName: upstreamAccounts.name,
          accountStatus: upstreamAccounts.status,
          accountSchedulable: upstreamAccounts.schedulable,
          accountPlatform: upstreamAccounts.platform,
          accountType: upstreamAccounts.type,
          accountDeletedAt: upstreamAccounts.deletedAt,
        })
        .from(accountGroupMembers)
        .innerJoin(
          upstreamAccounts,
          eq(upstreamAccounts.id, accountGroupMembers.accountId),
        )
        .where(eq(accountGroupMembers.groupId, group.id));

      return { ...group, members };
    }),

  create: permissionProcedure(
    z.object({
      orgId: uuid,
      name: z.string().min(1).max(255),
      description: z.string().max(10_000).optional(),
      platform: platformEnum,
      rateMultiplier: z.number().positive().max(10000).optional(),
      isExclusive: z.boolean().optional(),
    }),
    (_, input) => ({ type: "account_group.create", orgId: input.orgId }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    try {
      const [group] = await ctx.db
        .insert(accountGroups)
        .values({
          orgId: input.orgId,
          name: input.name,
          description: input.description ?? null,
          platform: input.platform,
          rateMultiplier:
            input.rateMultiplier !== undefined
              ? input.rateMultiplier.toString()
              : "1.0",
          isExclusive: input.isExclusive ?? false,
        })
        .returning();
      if (!group) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to insert account group",
        });
      }
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account_group.created",
        targetType: "account_group",
        targetId: group.id,
        orgId: group.orgId,
        metadata: { name: group.name, platform: group.platform },
      });
      return group;
    } catch (err) {
      if (isUniqueViolation(err, CONSTRAINT_GROUP_NAME)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "an account group with this name already exists in the org",
        });
      }
      throw err;
    }
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: uuid,
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(10_000).nullable().optional(),
        rateMultiplier: z.number().positive().max(10000).optional(),
        isExclusive: z.boolean().optional(),
        status: groupStatusEnum.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({ id: accountGroups.id, orgId: accountGroups.orgId })
        .from(accountGroups)
        .where(
          and(eq(accountGroups.id, input.id), isNull(accountGroups.deletedAt)),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account_group.update",
          orgId: existing.orgId,
          groupId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined)
        patch.description = input.description;
      if (input.rateMultiplier !== undefined)
        patch.rateMultiplier = input.rateMultiplier.toString();
      if (input.isExclusive !== undefined)
        patch.isExclusive = input.isExclusive;
      if (input.status !== undefined) patch.status = input.status;

      try {
        const [row] = await ctx.db
          .update(accountGroups)
          .set(patch)
          .where(eq(accountGroups.id, input.id))
          .returning();
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: "account_group.updated",
          targetType: "account_group",
          targetId: row.id,
          orgId: row.orgId,
          metadata: { fields: Object.keys(patch).filter((k) => k !== "updatedAt") },
        });
        return row;
      } catch (err) {
        if (isUniqueViolation(err, CONSTRAINT_GROUP_NAME)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "an account group with this name already exists in the org",
          });
        }
        throw err;
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({ id: accountGroups.id, orgId: accountGroups.orgId })
        .from(accountGroups)
        .where(
          and(eq(accountGroups.id, input.id), isNull(accountGroups.deletedAt)),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account_group.delete",
          orgId: existing.orgId,
          groupId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      // Soft-delete + flip status so the gateway scheduler stops considering
      // this group on its next selection pass (it filters status='active').
      // Also hard-delete the membership rows — they're an inner join'd
      // optimisation table, not authoritative, and leaving them around just
      // makes a future (unrelated) hard-delete of the group cascade
      // surprising. The member upstream_accounts themselves are untouched.
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(accountGroupMembers)
          .where(eq(accountGroupMembers.groupId, input.id));
        await tx
          .update(accountGroups)
          .set({
            deletedAt: sql`NOW()`,
            status: "disabled",
            updatedAt: sql`NOW()`,
          })
          .where(eq(accountGroups.id, input.id));
        await writeAudit(tx, {
          actorUserId: ctx.user.id,
          action: "account_group.deleted",
          targetType: "account_group",
          targetId: existing.id,
          orgId: existing.orgId,
          metadata: {},
        });
      });
      return { ok: true as const };
    }),

  addMember: protectedProcedure
    .input(
      z.object({
        groupId: uuid,
        accountId: uuid,
        priority: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [group, account] = await Promise.all([
        ctx.db
          .select({
            id: accountGroups.id,
            orgId: accountGroups.orgId,
            platform: accountGroups.platform,
          })
          .from(accountGroups)
          .where(
            and(
              eq(accountGroups.id, input.groupId),
              isNull(accountGroups.deletedAt),
            ),
          )
          .limit(1)
          .then((r) => r[0]),
        ctx.db
          .select({
            id: upstreamAccounts.id,
            orgId: upstreamAccounts.orgId,
            platform: upstreamAccounts.platform,
          })
          .from(upstreamAccounts)
          .where(
            and(
              eq(upstreamAccounts.id, input.accountId),
              isNull(upstreamAccounts.deletedAt),
            ),
          )
          .limit(1)
          .then((r) => r[0]),
      ]);
      if (!group)
        throw new TRPCError({ code: "NOT_FOUND", message: "group not found" });
      if (!account)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "account not found",
        });

      if (
        !can(ctx.perm, {
          type: "account_group.manage_members",
          orgId: group.orgId,
          groupId: group.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      // Cross-tenant integrity — same guard as accounts.create's team
      // check.  Without this an admin in orgA could pin an account from
      // orgB into their group.
      if (account.orgId !== group.orgId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "account does not belong to this group's org",
        });
      }
      // Platform must match — the gateway scheduler dispatches based on
      // group.platform; mixing platforms inside a group breaks routing.
      if (account.platform !== group.platform) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `account platform "${account.platform}" does not match group platform "${group.platform}"`,
        });
      }

      try {
        await ctx.db.insert(accountGroupMembers).values({
          accountId: account.id,
          groupId: group.id,
          priority: input.priority ?? 50,
        });
      } catch (err) {
        if (isUniqueViolation(err, CONSTRAINT_MEMBER_PK)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "account is already a member of this group",
          });
        }
        throw err;
      }
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account_group.member_added",
        targetType: "account_group",
        targetId: group.id,
        orgId: group.orgId,
        metadata: { accountId: account.id, priority: input.priority ?? 50 },
      });
      return { ok: true as const };
    }),

  removeMember: protectedProcedure
    .input(z.object({ groupId: uuid, accountId: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [group] = await ctx.db
        .select({ id: accountGroups.id, orgId: accountGroups.orgId })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.id, input.groupId),
            isNull(accountGroups.deletedAt),
          ),
        )
        .limit(1);
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account_group.manage_members",
          orgId: group.orgId,
          groupId: group.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const removed = await ctx.db
        .delete(accountGroupMembers)
        .where(
          and(
            eq(accountGroupMembers.groupId, input.groupId),
            eq(accountGroupMembers.accountId, input.accountId),
          ),
        )
        .returning({ accountId: accountGroupMembers.accountId });
      if (removed.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "account is not a member of this group",
        });
      }
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account_group.member_removed",
        targetType: "account_group",
        targetId: group.id,
        orgId: group.orgId,
        metadata: { accountId: input.accountId },
      });
      return { ok: true as const };
    }),

  setMemberPriority: protectedProcedure
    .input(
      z.object({
        groupId: uuid,
        accountId: uuid,
        priority: z.number().int().min(0).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [group] = await ctx.db
        .select({ id: accountGroups.id, orgId: accountGroups.orgId })
        .from(accountGroups)
        .where(
          and(
            eq(accountGroups.id, input.groupId),
            isNull(accountGroups.deletedAt),
          ),
        )
        .limit(1);
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account_group.manage_members",
          orgId: group.orgId,
          groupId: group.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updated = await ctx.db
        .update(accountGroupMembers)
        .set({ priority: input.priority })
        .where(
          and(
            eq(accountGroupMembers.groupId, input.groupId),
            eq(accountGroupMembers.accountId, input.accountId),
          ),
        )
        .returning({ accountId: accountGroupMembers.accountId });
      if (updated.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "account is not a member of this group",
        });
      }
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account_group.member_priority_set",
        targetType: "account_group",
        targetId: group.id,
        orgId: group.orgId,
        metadata: { accountId: input.accountId, priority: input.priority },
      });
      return { ok: true as const };
    }),
});
