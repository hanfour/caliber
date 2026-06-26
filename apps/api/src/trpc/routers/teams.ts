import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { teams, teamMembers } from '@caliber/db'
import { TRPCError } from '@trpc/server'
import {
  protectedProcedure,
  permissionProcedure,
  router
} from '../procedures.js'
import {
  assertDepartmentBelongsToOrg,
  assertUserMemberOfOrg
} from '../../services/tenancy.js'
import { mapServiceError } from '../errors.js'

// 2–63 chars: [a-z0-9], hyphens allowed in the middle, no leading/trailing
// hyphen. Kept in lockstep with the client schema (apps/web teams page) and the
// organizations/departments routers — a stricter server min silently 400s slugs
// the form accepted.
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/)
const uuid = z.string().uuid()

export const teamsRouter = router({
  list: protectedProcedure
    .input(z.object({ orgId: uuid.optional(), departmentId: uuid.optional() }))
    .query(async ({ ctx, input }) => {
      const ids = [...ctx.perm.coveredTeams]
      if (ids.length === 0) return []
      const conds = [inArray(teams.id, ids), isNull(teams.deletedAt)]
      if (input.orgId) conds.push(eq(teams.orgId, input.orgId))
      if (input.departmentId) conds.push(eq(teams.departmentId, input.departmentId))
      return ctx.db.select().from(teams).where(and(...conds))
    }),

  get: permissionProcedure(z.object({ id: uuid }), (_, input) => ({
    type: 'team.read',
    teamId: input.id
  })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, input.id), isNull(teams.deletedAt)))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  create: permissionProcedure(
    z.object({
      orgId: uuid,
      departmentId: uuid.optional(),
      name: z.string().min(1).max(255),
      slug
    }),
    (_, input) => ({
      type: 'team.create',
      orgId: input.orgId,
      deptId: input.departmentId
    })
  ).mutation(async ({ ctx, input }) => {
    if (input.departmentId) {
      try {
        await assertDepartmentBelongsToOrg(ctx.db, input.departmentId, input.orgId)
      } catch (e) {
        throw mapServiceError(e)
      }
    }
    const [row] = await ctx.db
      .insert(teams)
      .values({
        orgId: input.orgId,
        departmentId: input.departmentId ?? null,
        name: input.name,
        slug: input.slug
      })
      .returning()
    return row
  }),

  update: permissionProcedure(
    z.object({
      id: uuid,
      name: z.string().min(1).max(255).optional(),
      departmentId: uuid.nullable().optional()
    }),
    (_, input) => ({ type: 'team.update', teamId: input.id })
  ).mutation(async ({ ctx, input }) => {
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.departmentId !== undefined) {
      if (input.departmentId !== null) {
        // Look up team's org so we can prove the new department lives in it.
        const [existing] = await ctx.db
          .select({ orgId: teams.orgId })
          .from(teams)
          .where(eq(teams.id, input.id))
          .limit(1)
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
        try {
          await assertDepartmentBelongsToOrg(ctx.db, input.departmentId, existing.orgId)
        } catch (e) {
          throw mapServiceError(e)
        }
      }
      patch.departmentId = input.departmentId
    }
    const [row] = await ctx.db.update(teams).set(patch).where(eq(teams.id, input.id)).returning()
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  delete: permissionProcedure(z.object({ id: uuid }), (_, input) => ({
    type: 'team.delete',
    teamId: input.id
  })).mutation(async ({ ctx, input }) => {
    await ctx.db.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, input.id))
    return { id: input.id }
  }),

  addMember: permissionProcedure(
    z.object({ teamId: uuid, userId: uuid }),
    (_, input) => ({ type: 'team.add_member', teamId: input.teamId })
  ).mutation(async ({ ctx, input }) => {
    // Resolve team's org so the membership check rejects strangers.
    const [team] = await ctx.db
      .select({ orgId: teams.orgId })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), isNull(teams.deletedAt)))
      .limit(1)
    if (!team) throw new TRPCError({ code: 'NOT_FOUND' })
    try {
      await assertUserMemberOfOrg(ctx.db, input.userId, team.orgId)
    } catch (e) {
      throw mapServiceError(e)
    }
    await ctx.db
      .insert(teamMembers)
      .values({ teamId: input.teamId, userId: input.userId })
      .onConflictDoNothing()
    return { ok: true }
  }),

  removeMember: permissionProcedure(
    z.object({ teamId: uuid, userId: uuid }),
    (_, input) => ({ type: 'team.add_member', teamId: input.teamId })
  ).mutation(async ({ ctx, input }) => {
    await ctx.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, input.userId)))
    return { ok: true }
  })
})
