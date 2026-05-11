import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '@caliber/db'
import { roleAssignments } from '@caliber/db'
import type { Role, ScopeType } from '@caliber/auth'
import { ServiceError } from '../trpc/errors.js'
import { writeAudit } from './audit.js'

export async function grantRole(
  db: Database,
  grantedBy: string,
  input: { userId: string; role: Role; scopeType: ScopeType; scopeId: string | null }
) {
  const [row] = await db
    .insert(roleAssignments)
    .values({
      userId: input.userId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      grantedBy
    })
    .returning()
  if (!row) throw new ServiceError('CONFLICT', 'failed to insert role assignment')
  await writeAudit(db, {
    actorUserId: grantedBy,
    action: 'role.granted',
    targetType: 'role_assignment',
    targetId: row.id,
    metadata: {
      userId: row.userId,
      role: row.role,
      scopeType: row.scopeType,
      scopeId: row.scopeId
    }
  })
  return row
}

export async function revokeRole(db: Database, actorUserId: string, assignmentId: string) {
  const [row] = await db
    .update(roleAssignments)
    .set({ revokedAt: new Date() })
    .where(and(eq(roleAssignments.id, assignmentId), isNull(roleAssignments.revokedAt)))
    .returning({ id: roleAssignments.id })
  if (!row) throw new ServiceError('NOT_FOUND', 'assignment not found or already revoked')
  await writeAudit(db, {
    actorUserId,
    action: 'role.revoked',
    targetType: 'role_assignment',
    targetId: row.id
  })
  return { id: row.id }
}
