import { users, roleAssignments, organizationMembers, teamMembers } from '@caliber/db'
import type { Database } from '@caliber/db'
import type { Role, ScopeType } from '@caliber/auth'

let counter = 0

export interface MakeUserOpts {
  email?: string
  name?: string
  role?: Role
  scopeType?: ScopeType
  scopeId?: string | null
  orgId?: string
  teamId?: string
}

export async function makeUser(db: Database, opts: MakeUserOpts = {}) {
  counter++
  const email = opts.email ?? `u${counter}-${Date.now()}@t.test`
  const [user] = await db
    .insert(users)
    .values({ email, name: opts.name ?? email })
    .returning()
  if (!user) throw new Error('insert user failed')

  if (opts.orgId) {
    await db
      .insert(organizationMembers)
      .values({ orgId: opts.orgId, userId: user.id })
      .onConflictDoNothing()
  }
  if (opts.teamId) {
    await db
      .insert(teamMembers)
      .values({ teamId: opts.teamId, userId: user.id })
      .onConflictDoNothing()
  }
  if (opts.role) {
    await db.insert(roleAssignments).values({
      userId: user.id,
      role: opts.role,
      scopeType: opts.scopeType ?? 'global',
      scopeId: opts.scopeId ?? null
    })
  }
  return user
}
