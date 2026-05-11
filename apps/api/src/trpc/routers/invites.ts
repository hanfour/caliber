import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { invites } from "@caliber/db";
import { TRPCError } from "@trpc/server";
import { can } from "@caliber/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import {
  createInvite,
  revokeInvite,
  acceptInvite,
} from "../../services/invites.js";
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

export const invitesRouter = router({
  create: permissionProcedure(
    z.object({
      orgId: uuid,
      email: z.string().email(),
      role: roleEnum.exclude(["super_admin"]),
      scopeType: scopeEnum,
      scopeId: uuid.nullable(),
    }),
    (_, input) => ({
      type: "user.invite",
      orgId: input.orgId,
      deptId:
        input.scopeType === "department"
          ? (input.scopeId ?? undefined)
          : undefined,
      teamId:
        input.scopeType === "team" ? (input.scopeId ?? undefined) : undefined,
    }),
  ).mutation(async ({ ctx, input }) => {
    try {
      return await createInvite(ctx.db, ctx.user, input);
    } catch (e) {
      throw mapServiceError(e);
    }
  }),

  list: protectedProcedure
    .input(z.object({ orgId: uuid }))
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "user.invite", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return ctx.db
        .select()
        .from(invites)
        .where(and(eq(invites.orgId, input.orgId), isNull(invites.acceptedAt)));
    }),

  revoke: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ orgId: invites.orgId })
        .from(invites)
        .where(eq(invites.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (!can(ctx.perm, { type: "user.invite", orgId: existing.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        return await revokeInvite(ctx.db, ctx.user.id, input.id);
      } catch (e) {
        throw mapServiceError(e);
      }
    }),

  accept: protectedProcedure
    .input(z.object({ token: z.string().min(10).max(512) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await acceptInvite(ctx.db, ctx.user, input.token);
      } catch (e) {
        throw mapServiceError(e);
      }
    }),
});
