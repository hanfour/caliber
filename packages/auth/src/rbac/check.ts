import type { Action, Role, ScopeType } from "./actions.js";
import { ROLE_RANK } from "./actions.js";
import type { UserPermissions } from "./permissions.js";

function hasGlobal(perm: UserPermissions, role: Role): boolean {
  return perm.rolesAtGlobal.has(role);
}

function rolesAt(
  perm: UserPermissions,
  scopeType: Exclude<ScopeType, "global">,
  scopeId: string,
): Set<Role> {
  const map =
    scopeType === "organization"
      ? perm.rolesByOrg
      : scopeType === "department"
        ? perm.rolesByDept
        : perm.rolesByTeam;
  return map.get(scopeId) ?? new Set();
}

function coversOrg(perm: UserPermissions, orgId: string): boolean {
  return perm.coveredOrgs.has(orgId);
}
function coversDept(perm: UserPermissions, deptId: string): boolean {
  return perm.coveredDepts.has(deptId);
}
function coversTeam(perm: UserPermissions, teamId: string): boolean {
  return perm.coveredTeams.has(teamId);
}

function deptBelongsToOrg(
  perm: UserPermissions,
  deptId: string,
  orgId: string,
): boolean {
  return perm.deptOrgById.get(deptId) === orgId;
}

function teamBelongsToOrg(
  perm: UserPermissions,
  teamId: string,
  orgId: string,
): boolean {
  return perm.teamOrgById.get(teamId) === orgId;
}

function hasOrgAdminForDept(perm: UserPermissions, deptId: string): boolean {
  const orgId = perm.deptOrgById.get(deptId);
  return orgId !== undefined && rolesAt(perm, "organization", orgId).has("org_admin");
}

function hasOrgAdminForTeam(perm: UserPermissions, teamId: string): boolean {
  const orgId = perm.teamOrgById.get(teamId);
  return orgId !== undefined && rolesAt(perm, "organization", orgId).has("org_admin");
}

function hasDeptManagerForTeam(perm: UserPermissions, teamId: string): boolean {
  const deptId = perm.teamDeptById.get(teamId);
  return (
    deptId !== undefined &&
    deptId !== null &&
    rolesAt(perm, "department", deptId).has("dept_manager")
  );
}

function maxRoleForOrg(perm: UserPermissions, orgId: string): number {
  let max = 0;
  if (hasGlobal(perm, "super_admin"))
    max = Math.max(max, ROLE_RANK.super_admin);
  for (const r of rolesAt(perm, "organization", orgId))
    max = Math.max(max, ROLE_RANK[r]);
  return max;
}

function maxRoleForTeam(perm: UserPermissions, teamId: string): number {
  let max = 0;
  if (hasGlobal(perm, "super_admin"))
    max = Math.max(max, ROLE_RANK.super_admin);
  for (const r of rolesAt(perm, "team", teamId))
    max = Math.max(max, ROLE_RANK[r]);
  if (coversTeam(perm, teamId)) {
    if (hasOrgAdminForTeam(perm, teamId)) max = Math.max(max, ROLE_RANK.org_admin);
    if (hasDeptManagerForTeam(perm, teamId))
      max = Math.max(max, ROLE_RANK.dept_manager);
  }
  return max;
}

export function can(perm: UserPermissions, action: Action): boolean {
  if (hasGlobal(perm, "super_admin")) return true;

  switch (action.type) {
    case "org.read":
      return coversOrg(perm, action.orgId);
    case "org.update":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "org.create":
    case "org.delete":
      return false;
    case "dept.read":
      return coversDept(perm, action.deptId);
    case "dept.create":
    case "dept.update":
    case "dept.delete":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "team.read":
      return coversTeam(perm, action.teamId);
    case "team.create":
      if (rolesAt(perm, "organization", action.orgId).has("org_admin"))
        return true;
      if (action.deptId) {
        return (
          rolesAt(perm, "department", action.deptId).has("dept_manager") &&
          deptBelongsToOrg(perm, action.deptId, action.orgId) &&
          coversDept(perm, action.deptId)
        );
      }
      return false;
    case "team.update":
    case "team.delete":
    case "team.add_member":
      return (
        coversTeam(perm, action.teamId) &&
        maxRoleForTeam(perm, action.teamId) >= ROLE_RANK.team_manager
      );
    case "user.read":
      if (action.targetUserId === perm.userId) return true;
      return false;
    case "user.invite":
      if (action.teamId) {
        return (
          teamBelongsToOrg(perm, action.teamId, action.orgId) &&
          coversTeam(perm, action.teamId) &&
          maxRoleForTeam(perm, action.teamId) >= ROLE_RANK.team_manager
        );
      }
      if (action.deptId) {
        return (
          deptBelongsToOrg(perm, action.deptId, action.orgId) &&
          coversDept(perm, action.deptId) &&
          rolesAt(perm, "department", action.deptId).has("dept_manager")
        );
      }
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "role.grant": {
      const grantRank = ROLE_RANK[action.role];
      if (action.scopeType === "global") return false;
      const scopeId = action.scopeId ?? "";
      let actorRank = 0;
      if (action.scopeType === "organization") {
        actorRank = maxRoleForOrg(perm, scopeId);
      } else if (action.scopeType === "department") {
        const directDept = rolesAt(perm, "department", scopeId).has(
          "dept_manager",
        )
          ? ROLE_RANK.dept_manager
          : 0;
        const inheritedOrg =
          coversDept(perm, scopeId) && hasOrgAdminForDept(perm, scopeId)
            ? ROLE_RANK.org_admin
            : 0;
        actorRank = Math.max(directDept, inheritedOrg);
      } else if (action.scopeType === "team") {
        actorRank = maxRoleForTeam(perm, scopeId);
      }
      return actorRank > 0 && grantRank < actorRank;
    }
    case "role.revoke":
      return (
        perm.rolesAtGlobal.size > 0 ||
        perm.rolesByOrg.size > 0 ||
        perm.rolesByDept.size > 0
      );
    case "audit.read":
      if (action.deptId) {
        return (
          (deptBelongsToOrg(perm, action.deptId, action.orgId) &&
            rolesAt(perm, "department", action.deptId).has("dept_manager")) ||
          rolesAt(perm, "organization", action.orgId).has("org_admin")
        );
      }
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "account.read":
    case "account.create":
    case "account.update":
    case "account.rotate":
    case "account.delete":
    // Account groups are an org-level scheduling concern that mirrors the
    // org-admin gate on individual accounts.  Per Phase 3 #1 of the API key
    // migration plan, anyone allowed to manage upstream accounts can also
    // manage their grouping for load-balancing purposes.
    case "account_group.read":
    case "account_group.create":
    case "account_group.update":
    case "account_group.delete":
    case "account_group.manage_members":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "api_key.issue_own":
    case "api_key.list_own":
      return true;
    case "api_key.revoke":
    // Per-key "score as project" opt-in mirrors the revoke gate exactly:
    // the key owner may toggle their own key, and an org_admin may toggle
    // any key in their org. Same {apiKeyId, orgId, ownerUserId} shape.
    case "api_key.evaluate_as_project_set":
      if (action.ownerUserId === perm.userId) return true; // self
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "api_key.issue_for_user":
    case "api_key.list_all":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "device.list_own":
    case "enrollment_token.issue_own":
    case "account.register_own":
      return true;
    case "account.manage_own":
      return perm.userId === action.ownerUserId;
    case "device.revoke":
      if (action.ownerUserId === perm.userId) return true; // self-revoke
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "device.list_all":
    case "enrollment_token.issue_for_user":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "usage.read_own":
      return true;
    case "usage.read_user":
      if (action.targetUserId === perm.userId) return true;
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "usage.read_team":
      return (
        (teamBelongsToOrg(perm, action.teamId, action.orgId) &&
          rolesAt(perm, "team", action.teamId).has("team_manager")) ||
        rolesAt(perm, "organization", action.orgId).has("org_admin")
      );
    case "usage.read_org":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "content_capture.read":
    case "content_capture.toggle":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "report.read_own":
    case "report.export_own":
    case "report.delete_own":
      return true;
    case "report.read_user":
      if (action.targetUserId === perm.userId) return true;
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "report.read_team":
      return (
        (teamBelongsToOrg(perm, action.teamId, action.orgId) &&
          rolesAt(perm, "team", action.teamId).has("team_manager")) ||
        rolesAt(perm, "organization", action.orgId).has("org_admin")
      );
    case "report.read_org":
    case "report.rerun":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "rubric.read":
    case "rubric.create":
    case "rubric.update":
    case "rubric.delete":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "rubric.read_key":
    case "rubric.author_key":
    case "rubric.delete_key":
      if (action.ownerUserId === perm.userId) return true; // key owner (a member)
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "evaluator.read_status":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "evaluator.view_cost":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "github.manage":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
  }
}
