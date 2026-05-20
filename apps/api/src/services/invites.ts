import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '@caliber/db'
import { invites, organizationMembers, roleAssignments } from '@caliber/db'
import type { Role, ScopeType } from '@caliber/auth'
import { ServiceError } from '../trpc/errors.js'
import { writeAudit } from './audit.js'
import { assertScopeBelongsToOrg } from './tenancy.js'

function newToken() {
  return randomBytes(32).toString('base64url')
}

export async function createInvite(
  db: Database,
  inviter: { id: string },
  input: {
    orgId: string
    email: string
    role: Role
    scopeType: ScopeType
    scopeId: string | null
  }
) {
  // Cross-tenant guard: invite.scopeId must resolve to input.orgId for
  // dept/team scopes (and equal orgId for organization scope). Without this,
  // a caller with user.invite on org-A could create an invite whose role lands
  // on a department/team from org-B once accepted.
  await assertScopeBelongsToOrg(db, input.scopeType, input.scopeId, input.orgId)
  try {
    const [row] = await db
      .insert(invites)
      .values({
        orgId: input.orgId,
        email: input.email,
        role: input.role,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        token: newToken()
      })
      .returning()
    if (!row) throw new ServiceError('CONFLICT', 'invite already exists')
    await writeAudit(db, {
      actorUserId: inviter.id,
      action: 'invite.created',
      targetType: 'invite',
      targetId: row.id,
      orgId: row.orgId,
      metadata: {
        email: row.email,
        role: row.role,
        scopeType: row.scopeType,
        scopeId: row.scopeId
      }
    })
    return row
  } catch (err) {
    // Postgres unique_violation → surface as CONFLICT so router maps to 409.
    // drizzle 0.45 nests the pg error under `.cause` while older drizzle
    // exposed `.code` on the thrown error directly; check both shapes.
    for (const c of [err, (err as { cause?: unknown })?.cause]) {
      if (
        c &&
        typeof c === 'object' &&
        'code' in c &&
        (c as { code?: string }).code === '23505'
      ) {
        throw new ServiceError('CONFLICT', 'invite already exists')
      }
    }
    throw err
  }
}

export async function revokeInvite(db: Database, actorUserId: string, id: string) {
  // DELETE rather than tombstone — invites has UNIQUE(org_id, email) so leaving
  // a dead row would block re-inviting the same email. Audit log preserves
  // history of the revoke action. Capture orgId/email BEFORE delete so the
  // audit entry can record them.
  const [existing] = await db
    .select({
      id: invites.id,
      orgId: invites.orgId,
      email: invites.email,
      role: invites.role,
      scopeType: invites.scopeType,
      scopeId: invites.scopeId
    })
    .from(invites)
    .where(eq(invites.id, id))
    .limit(1)
  const [row] = await db
    .delete(invites)
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id })
  if (!row) throw new ServiceError('NOT_FOUND', 'invite not found or already used')
  await writeAudit(db, {
    actorUserId,
    action: 'invite.revoked',
    targetType: 'invite',
    targetId: row.id,
    orgId: existing?.orgId ?? null,
    metadata: existing
      ? {
          email: existing.email,
          role: existing.role,
          scopeType: existing.scopeType,
          scopeId: existing.scopeId
        }
      : {}
  })
  return { id: row.id }
}

export async function acceptInvite(
  db: Database,
  actor: { id: string; email: string },
  token: string
) {
  // Wrap in a transaction with SELECT … FOR UPDATE to prevent concurrent
  // accepts from creating duplicate role_assignments. Drizzle's builder-level
  // `.for('update')` lock compiles cleanly and avoids raw-sql driver quirks.
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.token, token),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date())
        )
      )
      .limit(1)
      .for('update')
    if (!invite) throw new ServiceError('NOT_FOUND', 'invalid or expired invite')
    if (invite.email.toLowerCase() !== actor.email.toLowerCase()) {
      throw new ServiceError('FORBIDDEN', 'invite email does not match')
    }
    // Defensive re-check: invite was validated at create time, but the
    // referenced department/team could have been deleted or (in older rows
    // predating this guard) was never validated. Reject before granting a
    // role with a dangling/foreign scopeId.
    await assertScopeBelongsToOrg(tx, invite.scopeType, invite.scopeId, invite.orgId)
    await tx
      .insert(organizationMembers)
      .values({ orgId: invite.orgId, userId: actor.id })
      .onConflictDoNothing()
    await tx.insert(roleAssignments).values({
      userId: actor.id,
      role: invite.role,
      scopeType: invite.scopeType,
      scopeId: invite.scopeId
    })
    await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.id, invite.id))
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: 'invite.accepted',
      targetType: 'invite',
      targetId: invite.id,
      orgId: invite.orgId,
      metadata: {
        email: invite.email,
        role: invite.role,
        scopeType: invite.scopeType,
        scopeId: invite.scopeId
      }
    })
    return { orgId: invite.orgId }
  })
}
