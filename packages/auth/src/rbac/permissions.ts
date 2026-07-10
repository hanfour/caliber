import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '@caliber/db'
import { roleAssignments, organizations, departments, teams } from '@caliber/db'
import type { Role, ScopeType } from './actions.js'
import { expandScope } from './scope.js'

export interface ActiveAssignment {
  id: string
  role: Role
  scopeType: ScopeType
  scopeId: string | null
}

export interface UserPermissions {
  userId: string
  assignments: ActiveAssignment[]
  rolesAtGlobal: Set<Role>
  rolesByOrg: Map<string, Set<Role>>
  rolesByDept: Map<string, Set<Role>>
  rolesByTeam: Map<string, Set<Role>>
  coveredOrgs: Set<string>
  coveredDepts: Set<string>
  coveredTeams: Set<string>
  deptOrgById: Map<string, string>
  teamOrgById: Map<string, string>
  teamDeptById: Map<string, string | null>
}

export async function resolvePermissions(
  db: Database,
  userId: string
): Promise<UserPermissions> {
  const rows = await db
    .select({
      id: roleAssignments.id,
      role: roleAssignments.role,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId
    })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), isNull(roleAssignments.revokedAt)))

  const [orgRows, deptRows, teamRows] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(isNull(organizations.deletedAt)),
    db
      .select({ id: departments.id, orgId: departments.orgId })
      .from(departments)
      .where(isNull(departments.deletedAt)),
    db
      .select({ id: teams.id, orgId: teams.orgId, departmentId: teams.departmentId })
      .from(teams)
      .where(isNull(teams.deletedAt))
  ])
  const corpus = { orgs: orgRows, depts: deptRows, teams: teamRows }

  // Build fast lookup: deptId -> orgId so dept/team assignments can walk up to
  // the parent org and populate coveredOrgs. This matches the assumption in
  // check.ts's inheritance logic (tested in Task 3).
  const deptOrgIndex = new Map<string, string>()
  for (const d of deptRows) deptOrgIndex.set(d.id, d.orgId)
  const teamOrgIndex = new Map<string, string>()
  for (const t of teamRows) teamOrgIndex.set(t.id, t.orgId)
  const teamDeptIndex = new Map<string, string | null>()
  for (const t of teamRows) teamDeptIndex.set(t.id, t.departmentId)

  const rolesAtGlobal = new Set<Role>()
  const rolesByOrg = new Map<string, Set<Role>>()
  const rolesByDept = new Map<string, Set<Role>>()
  const rolesByTeam = new Map<string, Set<Role>>()
  const coveredOrgs = new Set<string>()
  const coveredDepts = new Set<string>()
  const coveredTeams = new Set<string>()

  const assignments: ActiveAssignment[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    scopeType: r.scopeType,
    scopeId: r.scopeId
  }))

  for (const a of assignments) {
    if (a.scopeType === 'global') {
      rolesAtGlobal.add(a.role)
    } else if (a.scopeId) {
      const map =
        a.scopeType === 'organization'
          ? rolesByOrg
          : a.scopeType === 'department'
            ? rolesByDept
            : rolesByTeam
      const set = map.get(a.scopeId) ?? new Set<Role>()
      set.add(a.role)
      map.set(a.scopeId, set)
    }

    const exp = expandScope(a, corpus)
    for (const o of exp.orgs) coveredOrgs.add(o)
    for (const d of exp.depts) coveredDepts.add(d)
    for (const t of exp.teams) coveredTeams.add(t)

    // Propagate upward so dept/team assignments also cover their parent org.
    if (a.scopeType === 'department' && a.scopeId) {
      const parentOrg = deptOrgIndex.get(a.scopeId)
      if (parentOrg) coveredOrgs.add(parentOrg)
    }
    if (a.scopeType === 'team' && a.scopeId) {
      const parentOrg = teamOrgIndex.get(a.scopeId)
      if (parentOrg) coveredOrgs.add(parentOrg)
    }
  }

  return {
    userId,
    assignments,
    rolesAtGlobal,
    rolesByOrg,
    rolesByDept,
    rolesByTeam,
    coveredOrgs,
    coveredDepts,
    coveredTeams,
    deptOrgById: deptOrgIndex,
    teamOrgById: teamOrgIndex,
    teamDeptById: teamDeptIndex
  }
}
