import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { departments } from '@caliber/db'
import { TRPCError } from '@trpc/server'
import {
  protectedProcedure,
  permissionProcedure,
  router
} from '../procedures.js'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
const uuid = z.string().uuid()

export const departmentsRouter = router({
  list: permissionProcedure(z.object({ orgId: uuid }), (_, input) => ({
    type: 'org.read',
    orgId: input.orgId
  })).query(async ({ ctx, input }) => {
    return ctx.db
      .select()
      .from(departments)
      .where(and(eq(departments.orgId, input.orgId), isNull(departments.deletedAt)))
  }),

  get: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(departments)
        .where(and(eq(departments.id, input.id), isNull(departments.deletedAt)))
        .limit(1)
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      if (!ctx.perm.coveredDepts.has(row.id)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      return row
    }),

  create: permissionProcedure(
    z.object({ orgId: uuid, name: z.string().min(1).max(255), slug }),
    (_, input) => ({ type: 'dept.create', orgId: input.orgId })
  ).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db.insert(departments).values(input).returning()
    return row
  }),

  update: protectedProcedure
    .input(z.object({ id: uuid, name: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ orgId: departments.orgId, id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, input.id), isNull(departments.deletedAt)))
        .limit(1)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      const ok =
        ctx.perm.rolesAtGlobal.has('super_admin') ||
        (ctx.perm.rolesByOrg.get(existing.orgId)?.has('org_admin') ?? false)
      if (!ok) throw new TRPCError({ code: 'FORBIDDEN' })
      const [row] = await ctx.db
        .update(departments)
        .set({ name: input.name })
        .where(eq(departments.id, input.id))
        .returning()
      return row
    }),

  delete: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ orgId: departments.orgId, id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, input.id), isNull(departments.deletedAt)))
        .limit(1)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      const ok =
        ctx.perm.rolesAtGlobal.has('super_admin') ||
        (ctx.perm.rolesByOrg.get(existing.orgId)?.has('org_admin') ?? false)
      if (!ok) throw new TRPCError({ code: 'FORBIDDEN' })
      await ctx.db
        .update(departments)
        .set({ deletedAt: new Date() })
        .where(eq(departments.id, input.id))
      return { id: input.id }
    })
})
