import { z } from 'zod'
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { auditLogs, users } from '@caliber/db'
import { TRPCError } from '@trpc/server'
import { protectedProcedure, router } from '../procedures.js'

const uuid = z.string().uuid()

export const auditLogsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        orgId: uuid,
        actorId: uuid.optional(),
        action: z.string().max(255).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: z.number().int().min(1).max(500).default(100)
      })
    )
    .query(async ({ ctx, input }) => {
      const ok =
        ctx.perm.rolesAtGlobal.has('super_admin') ||
        (ctx.perm.rolesByOrg.get(input.orgId)?.has('org_admin') ?? false)
      if (!ok) throw new TRPCError({ code: 'FORBIDDEN' })
      const conds: SQL[] = [eq(auditLogs.orgId, input.orgId)]
      if (input.actorId) conds.push(eq(auditLogs.actorUserId, input.actorId))
      if (input.action) conds.push(eq(auditLogs.action, input.action))
      if (input.since) conds.push(gte(auditLogs.createdAt, input.since))
      if (input.until) conds.push(lte(auditLogs.createdAt, input.until))
      return ctx.db
        .select({
          id: sql<string>`cast(${auditLogs.id} as text)`.as('id'),
          actorUserId: auditLogs.actorUserId,
          actorEmail: users.email,
          action: auditLogs.action,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          orgId: auditLogs.orgId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(and(...conds))
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.limit)
    })
})
