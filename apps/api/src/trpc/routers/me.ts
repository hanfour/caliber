import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { users, organizations, organizationMembers } from "@caliber/db";
import { protectedProcedure, router } from "../procedures.js";

export const meRouter = router({
  session: protectedProcedure.query(({ ctx }) => ({
    user: ctx.user,
    assignments: ctx.perm.assignments,
    coveredOrgs: [...ctx.perm.coveredOrgs],
    coveredDepts: [...ctx.perm.coveredDepts],
    coveredTeams: [...ctx.perm.coveredTeams],
  })),
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255).optional(),
        image: z.string().url().max(1024).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.image !== undefined) patch.image = input.image;
      const [row] = await ctx.db
        .update(users)
        .set(patch)
        .where(eq(users.id, ctx.user.id))
        .returning();
      return row;
    }),
  captureDisclosure: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        orgId: organizations.id,
        orgSlug: organizations.slug,
        orgName: organizations.name,
        contentCaptureEnabled: organizations.contentCaptureEnabled,
        retentionDaysOverride: organizations.retentionDaysOverride,
        llmEvalEnabled: organizations.llmEvalEnabled,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.userId, ctx.user.id),
          eq(organizations.contentCaptureEnabled, true),
          isNull(organizations.deletedAt),
        ),
      );

    return rows.map((r) => ({
      orgId: r.orgId,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      contentCaptureEnabled: r.contentCaptureEnabled,
      retentionDays: r.retentionDaysOverride ?? 90,
      llmEvalEnabled: r.llmEvalEnabled,
    }));
  }),
});
