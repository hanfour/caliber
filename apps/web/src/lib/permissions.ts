import type { UserPermissions } from "@caliber/auth/rbac";
import type { Role, ScopeType } from "@caliber/auth/rbac";

export interface SessionPayload {
  user: { id: string };
  assignments: Array<{
    id: string;
    role: Role;
    scopeType: ScopeType;
    scopeId: string | null;
  }>;
  coveredOrgs: string[];
  coveredDepts: string[];
  coveredTeams: string[];
  deptOrgById?: Array<readonly [string, string]>;
  teamOrgById?: Array<readonly [string, string]>;
  teamDeptById?: Array<readonly [string, string | null]>;
}

export function buildPermissionsFromSession(
  session: SessionPayload,
): UserPermissions {
  const rolesAtGlobal = new Set<Role>();
  const rolesByOrg = new Map<string, Set<Role>>();
  const rolesByDept = new Map<string, Set<Role>>();
  const rolesByTeam = new Map<string, Set<Role>>();

  for (const a of session.assignments) {
    if (a.scopeType === "global") {
      rolesAtGlobal.add(a.role);
    } else if (a.scopeId) {
      const map =
        a.scopeType === "organization"
          ? rolesByOrg
          : a.scopeType === "department"
            ? rolesByDept
            : rolesByTeam;
      const set = map.get(a.scopeId) ?? new Set<Role>();
      set.add(a.role);
      map.set(a.scopeId, set);
    }
  }

  return {
    userId: session.user.id,
    assignments: session.assignments,
    rolesAtGlobal,
    rolesByOrg,
    rolesByDept,
    rolesByTeam,
    coveredOrgs: new Set(session.coveredOrgs),
    coveredDepts: new Set(session.coveredDepts),
    coveredTeams: new Set(session.coveredTeams),
    deptOrgById: new Map(session.deptOrgById ?? []),
    teamOrgById: new Map(session.teamOrgById ?? []),
    teamDeptById: new Map(session.teamDeptById ?? []),
  };
}
