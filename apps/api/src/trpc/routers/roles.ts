import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  roleAssignments,
  users,
  organizationMembers,
  teamMembers,
} from "@caliber/db";
import { TRPCError } from "@trpc/server";
import { can } from "@caliber/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { grantRole, revokeRole } from "../../services/roles.js";
import { mapServiceError } from "../errors.js";

const uuid = z.string().uuid();
const roleEnum = z.enum([
  "super_admin",
  "org_admin",
  "dept_manager",
  "team_manager",
  "member",
]);
const scopeEnum = z.enum(["global", "organization", "department", "team"]);

export const rolesRouter = router({
  grant: permissionProcedure(
    z.object({
      userId: uuid,
      role: roleEnum,
      scopeType: scopeEnum,
      scopeId: uuid.nullable(),
    }),
    (_, input) => ({
      type: "role.grant",
      targetUserId: input.userId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    }),
  ).mutation(async ({ ctx, input }) => {
    // verify target user exists so we don't surface raw FK violation to the client
    const [existing] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!existing)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "target user not found",
      });
    try {
      return await grantRole(ctx.db, ctx.user.id, input);
    } catch (e) {
      throw mapServiceError(e);
    }
  }),

  revoke: protectedProcedure
    .input(z.object({ assignmentId: uuid }))
    .mutation(async ({ ctx, input }) => {
      // Load the assignment to know what role/scope we're revoking.
      const [a] = await ctx.db
        .select({
          id: roleAssignments.id,
          userId: roleAssignments.userId,
          role: roleAssignments.role,
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          revokedAt: roleAssignments.revokedAt,
        })
        .from(roleAssignments)
        .where(eq(roleAssignments.id, input.assignmentId))
        .limit(1);
      if (!a || a.revokedAt) throw new TRPCError({ code: "NOT_FOUND" });

      // Same-authority check: actor must be able to GRANT this role at this
      // scope in order to revoke it. Prevents an org_admin in org A from
      // revoking assignments in org B.
      const ok = can(ctx.perm, {
        type: "role.grant",
        targetUserId: a.userId,
        role: a.role,
        scopeType: a.scopeType,
        scopeId: a.scopeId,
      });
      if (!ok) throw new TRPCError({ code: "FORBIDDEN" });

      try {
        return await revokeRole(ctx.db, ctx.user.id, input.assignmentId);
      } catch (e) {
        throw mapServiceError(e);
      }
    }),

  listForUser: protectedProcedure
    .input(z.object({ userId: uuid }))
    .query(async ({ ctx, input }) => {
      if (input.userId !== ctx.user.id) {
        // Non-self: must have user.read coverage for target. Same walk as
        // users.get — check shared covered team first, then org_admin path.
        // Dept/team managers are intentionally excluded from the org path
        // because their coveredOrgs contains the parent org solely for scope
        // inheritance (spec §5.1 dept/team are team-bounded).
        const teamIds = [...ctx.perm.coveredTeams];
        let ok = ctx.perm.rolesAtGlobal.has("super_admin");
        if (!ok && teamIds.length > 0) {
          const shared = await ctx.db
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.userId, input.userId),
                inArray(teamMembers.teamId, teamIds),
              ),
            )
            .limit(1);
          if (shared.length > 0) ok = true;
        }
        if (!ok) {
          const orgAdminOrgIds = [...ctx.perm.rolesByOrg.entries()]
            .filter(([, roles]) => roles.has("org_admin"))
            .map(([orgId]) => orgId);
          if (orgAdminOrgIds.length > 0) {
            const sharedOrg = await ctx.db
              .select({ orgId: organizationMembers.orgId })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.userId, input.userId),
                  inArray(organizationMembers.orgId, orgAdminOrgIds),
                ),
              )
              .limit(1);
            if (sharedOrg.length > 0) ok = true;
          }
        }
        if (!ok) throw new TRPCError({ code: "FORBIDDEN" });
      }
      return ctx.db
        .select()
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.userId, input.userId),
            isNull(roleAssignments.revokedAt),
          ),
        );
    }),
});
