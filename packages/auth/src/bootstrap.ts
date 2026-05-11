import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '@caliber/db'
import { users, invites } from '@caliber/db'

export interface BootstrapConfig {
  superAdminEmail: string
  defaultOrgSlug: string
  defaultOrgName: string
}

export type SignUpDecision =
  | { allowed: true; action: 'link'; userId: string }
  | { allowed: true; action: 'invite'; inviteId: string; orgId: string }
  | { allowed: true; action: 'bootstrap' }
  | { allowed: false; reason: 'no-invite' | 'invite-expired' }

export async function decideSignUp(
  db: Database,
  email: string,
  cfg: BootstrapConfig
): Promise<SignUpDecision> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (existing) {
    return { allowed: true, action: 'link', userId: existing.id }
  }

  const now = new Date()
  const invite = await db.query.invites.findFirst({
    where: and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, now))
  })
  if (invite) {
    return { allowed: true, action: 'invite', inviteId: invite.id, orgId: invite.orgId }
  }

  const anyUser = await db.query.users.findFirst()
  if (!anyUser && email === cfg.superAdminEmail) {
    return { allowed: true, action: 'bootstrap' }
  }

  return { allowed: false, reason: 'no-invite' }
}
