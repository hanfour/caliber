import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { organizations } from '@caliber/db'
import { TRPCError } from '@trpc/server'
import {
  protectedProcedure,
  permissionProcedure,
  router
} from '../procedures.js'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
const uuid = z.string().uuid()

export const organizationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const ids = [...ctx.perm.coveredOrgs]
    if (ids.length === 0) return []
    return ctx.db
      .select()
      .from(organizations)
      .where(and(inArray(organizations.id, ids), isNull(organizations.deletedAt)))
  }),

  get: permissionProcedure(z.object({ id: uuid }), (_, input) => ({
    type: 'org.read',
    orgId: input.id
  })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, input.id), isNull(organizations.deletedAt)))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  /**
   * Resolve a URL identifier (slug OR UUID) to the canonical org row.
   * Lets pages with `[id]` dynamic segments accept either form without
   * each tRPC mutation needing to swallow both shapes.
   *
   * Closes #70: previously the New Account form passed `params.id`
   * (often the slug like `local`) directly to mutations whose schemas
   * required `z.string().uuid()`, so the BAD_REQUEST surfaced as a
   * useless toast. Pages now resolve via this query before calling
   * any orgId-typed mutation.
   *
   * `protectedProcedure` (no permission gate) intentionally — the
   * lookup itself is harmless (returns NOT_FOUND for orgs the caller
   * can't see, identical to the no-such-slug path), and downstream
   * mutations still apply their own RBAC against the resolved UUID.
   */
  resolveIdentifier: protectedProcedure
    .input(z.object({ identifier: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const isUuid = uuid.safeParse(input.identifier).success
      const cond = isUuid
        ? eq(organizations.id, input.identifier)
        : eq(organizations.slug, input.identifier)
      const [row] = await ctx.db
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name
        })
        .from(organizations)
        .where(and(cond, isNull(organizations.deletedAt)))
        .limit(1)
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      // Hide existence from callers without permission to read this
      // org — match the same surface as `get` above.
      if (!ctx.perm.coveredOrgs.has(row.id)) {
        throw new TRPCError({ code: 'NOT_FOUND' })
      }
      return row
    }),

  create: protectedProcedure
    .input(z.object({ slug, name: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.perm.rolesAtGlobal.has('super_admin')) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db.insert(organizations).values(input).returning()
      return row
    }),

  update: permissionProcedure(
    z.object({ id: uuid, name: z.string().min(1).max(255) }),
    (_, input) => ({ type: 'org.update', orgId: input.id })
  ).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(organizations)
      .set({ name: input.name })
      .where(eq(organizations.id, input.id))
      .returning()
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  delete: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.perm.rolesAtGlobal.has('super_admin')) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db
        .update(organizations)
        .set({ deletedAt: new Date() })
        .where(eq(organizations.id, input.id))
        .returning({ id: organizations.id })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return { id: row.id }
    })
})
