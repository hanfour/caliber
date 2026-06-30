import { describe, it, expect } from "vitest";
import { can } from "../../../src/rbac/check";
import type { UserPermissions } from "../../../src/rbac/permissions";
import type { Action, Role, ScopeType } from "../../../src/rbac/actions";

function makePerm(
  rows: ReadonlyArray<{
    role: Role;
    scopeType: ScopeType;
    scopeId: string | null;
  }>,
  covered: {
    orgs?: string[];
    depts?: string[];
    teams?: string[];
  } = {},
): UserPermissions {
  const rolesAtGlobal = new Set<Role>(
    rows.filter((r) => r.scopeType === "global").map((r) => r.role),
  );
  const rolesByOrg = new Map<string, Set<Role>>();
  const rolesByDept = new Map<string, Set<Role>>();
  const rolesByTeam = new Map<string, Set<Role>>();
  for (const r of rows) {
    if (!r.scopeId) continue;
    const map =
      r.scopeType === "organization"
        ? rolesByOrg
        : r.scopeType === "department"
          ? rolesByDept
          : r.scopeType === "team"
            ? rolesByTeam
            : null;
    if (!map) continue;
    const set = map.get(r.scopeId) ?? new Set<Role>();
    set.add(r.role);
    map.set(r.scopeId, set);
  }
  return {
    userId: "actor-1",
    assignments: rows.map((r) => ({
      id: "a",
      role: r.role,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
    })),
    rolesAtGlobal,
    rolesByOrg,
    rolesByDept,
    rolesByTeam,
    coveredOrgs: new Set(covered.orgs ?? []),
    coveredDepts: new Set(covered.depts ?? []),
    coveredTeams: new Set(covered.teams ?? []),
  };
}

type Case = [
  label: string,
  perm: UserPermissions,
  action: Action,
  expected: boolean,
];

const superAdmin = makePerm([
  { role: "super_admin", scopeType: "global", scopeId: null },
]);
const orgAdminOrg1 = makePerm(
  [{ role: "org_admin", scopeType: "organization", scopeId: "org-1" }],
  {
    orgs: ["org-1"],
    depts: ["dept-1a", "dept-1b"],
    teams: ["team-1a", "team-1b"],
  },
);
const deptMgrDept1a = makePerm(
  [{ role: "dept_manager", scopeType: "department", scopeId: "dept-1a" }],
  { orgs: ["org-1"], depts: ["dept-1a"], teams: ["team-1a"] },
);
const teamMgrTeam1a = makePerm(
  [{ role: "team_manager", scopeType: "team", scopeId: "team-1a" }],
  { teams: ["team-1a"] },
);
const memberTeam1a = makePerm(
  [{ role: "member", scopeType: "team", scopeId: "team-1a" }],
  { teams: ["team-1a"] },
);
const orgAdminOrg2 = makePerm(
  [{ role: "org_admin", scopeType: "organization", scopeId: "org-2" }],
  { orgs: ["org-2"], depts: ["dept-2a"], teams: ["team-2a"] },
);
const deptMgrDept1b = makePerm(
  [{ role: "dept_manager", scopeType: "department", scopeId: "dept-1b" }],
  { depts: ["dept-1b"], teams: ["team-1b"] },
);

const cases: Case[] = [
  // baseline matrix (same as original Plan 2 Task 3)
  [
    "super_admin can do anything — org.update",
    superAdmin,
    { type: "org.update", orgId: "org-x" },
    true,
  ],
  [
    "super_admin — role.grant super_admin global",
    superAdmin,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "super_admin",
      scopeType: "global",
      scopeId: null,
    },
    true,
  ],
  [
    "org_admin can update own org",
    orgAdminOrg1,
    { type: "org.update", orgId: "org-1" },
    true,
  ],
  [
    "org_admin cannot update another org",
    orgAdminOrg1,
    { type: "org.update", orgId: "org-2" },
    false,
  ],
  ["org_admin cannot create org", orgAdminOrg1, { type: "org.create" }, false],
  [
    "org_admin can create dept in own org",
    orgAdminOrg1,
    { type: "dept.create", orgId: "org-1" },
    true,
  ],
  [
    "org_admin cannot create dept in other org",
    orgAdminOrg1,
    { type: "dept.create", orgId: "org-2" },
    false,
  ],
  [
    "org_admin can create team in own org",
    orgAdminOrg1,
    { type: "team.create", orgId: "org-1" },
    true,
  ],
  [
    "org_admin can add_member to team in own org",
    orgAdminOrg1,
    { type: "team.add_member", teamId: "team-1a" },
    true,
  ],
  [
    "org_admin can invite in own org",
    orgAdminOrg1,
    { type: "user.invite", orgId: "org-1" },
    true,
  ],
  [
    "org_admin cannot invite to other org",
    orgAdminOrg1,
    { type: "user.invite", orgId: "org-2" },
    false,
  ],
  [
    "org_admin can grant team_manager in own team",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "team_manager",
      scopeType: "team",
      scopeId: "team-1a",
    },
    true,
  ],
  [
    "org_admin cannot grant org_admin on another org",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "org_admin",
      scopeType: "organization",
      scopeId: "org-2",
    },
    false,
  ],
  [
    "org_admin cannot grant super_admin",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "super_admin",
      scopeType: "global",
      scopeId: null,
    },
    false,
  ],
  [
    "dept_manager can update team in own dept",
    deptMgrDept1a,
    { type: "team.update", teamId: "team-1a" },
    true,
  ],
  [
    "dept_manager cannot update team outside dept",
    deptMgrDept1a,
    { type: "team.update", teamId: "team-1b" },
    false,
  ],
  [
    "dept_manager can create team in own dept",
    deptMgrDept1a,
    { type: "team.create", orgId: "org-1", deptId: "dept-1a" },
    true,
  ],
  [
    "dept_manager cannot create team in other dept",
    deptMgrDept1a,
    { type: "team.create", orgId: "org-1", deptId: "dept-1b" },
    false,
  ],
  [
    "dept_manager cannot delete org",
    deptMgrDept1a,
    { type: "org.delete", orgId: "org-1" },
    false,
  ],
  [
    "dept_manager can grant member at own team",
    deptMgrDept1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1a",
    },
    true,
  ],
  [
    "dept_manager cannot grant dept_manager",
    deptMgrDept1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "dept_manager",
      scopeType: "department",
      scopeId: "dept-1a",
    },
    false,
  ],
  [
    "dept_manager can read audit for own dept",
    deptMgrDept1a,
    { type: "audit.read", orgId: "org-1", deptId: "dept-1a" },
    true,
  ],
  [
    "dept_manager cannot read audit for another dept",
    deptMgrDept1a,
    { type: "audit.read", orgId: "org-1", deptId: "dept-1b" },
    false,
  ],
  [
    "team_manager can update own team",
    teamMgrTeam1a,
    { type: "team.update", teamId: "team-1a" },
    true,
  ],
  [
    "team_manager cannot update another team",
    teamMgrTeam1a,
    { type: "team.update", teamId: "team-1b" },
    false,
  ],
  [
    "team_manager can add_member to own team",
    teamMgrTeam1a,
    { type: "team.add_member", teamId: "team-1a" },
    true,
  ],
  [
    "team_manager cannot add_member to other team",
    teamMgrTeam1a,
    { type: "team.add_member", teamId: "team-1b" },
    false,
  ],
  [
    "team_manager can invite to own team",
    teamMgrTeam1a,
    { type: "user.invite", orgId: "org-1", teamId: "team-1a" },
    true,
  ],
  [
    "team_manager cannot invite to other team",
    teamMgrTeam1a,
    { type: "user.invite", orgId: "org-1", teamId: "team-1b" },
    false,
  ],
  [
    "team_manager can grant member on own team",
    teamMgrTeam1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1a",
    },
    true,
  ],
  [
    "team_manager cannot grant team_manager",
    teamMgrTeam1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "team_manager",
      scopeType: "team",
      scopeId: "team-1a",
    },
    false,
  ],
  [
    "team_manager cannot create team",
    teamMgrTeam1a,
    { type: "team.create", orgId: "org-1" },
    false,
  ],
  [
    "team_manager cannot read audit",
    teamMgrTeam1a,
    { type: "audit.read", orgId: "org-1" },
    false,
  ],
  [
    "member can read self",
    memberTeam1a,
    { type: "user.read", targetUserId: "actor-1" },
    true,
  ],
  [
    "member cannot read teammate",
    memberTeam1a,
    { type: "user.read", targetUserId: "other" },
    false,
  ],
  [
    "member cannot update own team",
    memberTeam1a,
    { type: "team.update", teamId: "team-1a" },
    false,
  ],
  [
    "member cannot invite",
    memberTeam1a,
    { type: "user.invite", orgId: "org-1", teamId: "team-1a" },
    false,
  ],
  [
    "member cannot read audit",
    memberTeam1a,
    { type: "audit.read", orgId: "org-1" },
    false,
  ],
  [
    "member cannot grant anything",
    memberTeam1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1a",
    },
    false,
  ],
];

const crossBoundaryCases: Case[] = [
  [
    "org_admin of org-1 cannot read org-2",
    orgAdminOrg1,
    { type: "org.read", orgId: "org-2" },
    false,
  ],
  [
    "org_admin of org-1 cannot create dept in org-2",
    orgAdminOrg1,
    { type: "dept.create", orgId: "org-2" },
    false,
  ],
  [
    "org_admin of org-1 cannot create team in org-2",
    orgAdminOrg1,
    { type: "team.create", orgId: "org-2" },
    false,
  ],
  [
    "org_admin of org-2 cannot invite into org-1",
    orgAdminOrg2,
    { type: "user.invite", orgId: "org-1" },
    false,
  ],
  [
    "dept_manager of org-1 dept cannot manage team in org-2",
    deptMgrDept1a,
    { type: "team.update", teamId: "team-2a" },
    false,
  ],
  [
    "dept_manager of dept-1a cannot grant member on team-1b",
    deptMgrDept1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1b",
    },
    false,
  ],
  [
    "dept_manager of dept-1a cannot update team-1b",
    deptMgrDept1a,
    { type: "team.update", teamId: "team-1b" },
    false,
  ],
  [
    "dept_manager of dept-1a cannot read dept-1b",
    deptMgrDept1a,
    { type: "dept.read", orgId: "org-1", deptId: "dept-1b" },
    false,
  ],
  [
    "org_admin cannot grant org_admin peer",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "org_admin",
      scopeType: "organization",
      scopeId: "org-1",
    },
    false,
  ],
  [
    "dept_manager cannot grant dept_manager on own dept",
    deptMgrDept1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "dept_manager",
      scopeType: "department",
      scopeId: "dept-1a",
    },
    false,
  ],
  [
    "team_manager cannot grant team_manager on own team",
    teamMgrTeam1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "team_manager",
      scopeType: "team",
      scopeId: "team-1a",
    },
    false,
  ],
  [
    "dept_manager cannot create team claiming wrong org",
    deptMgrDept1a,
    { type: "team.create", orgId: "org-2", deptId: "dept-1a" },
    false,
  ],
  [
    "member cannot read dept",
    memberTeam1a,
    { type: "dept.read", orgId: "org-1", deptId: "dept-1a" },
    false,
  ],
  [
    "member cannot invite",
    memberTeam1a,
    { type: "user.invite", orgId: "org-1" },
    false,
  ],
  [
    "member cannot role.grant member",
    memberTeam1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1a",
    },
    false,
  ],
];

const extraCoverageCases: Case[] = [
  // team.read — coversTeam true/false paths
  [
    "member can read own team via coverage",
    memberTeam1a,
    { type: "team.read", teamId: "team-1a" },
    true,
  ],
  [
    "member cannot read team outside coverage",
    memberTeam1a,
    { type: "team.read", teamId: "team-other" },
    false,
  ],
  // user.invite with deptId (no teamId) — hits line 117
  [
    "dept_manager can invite at dept scope",
    deptMgrDept1a,
    { type: "user.invite", orgId: "org-1", deptId: "dept-1a" },
    true,
  ],
  [
    "dept_manager cannot invite at another dept",
    deptMgrDept1a,
    { type: "user.invite", orgId: "org-1", deptId: "dept-1b" },
    false,
  ],
  // role.revoke — requires any assignment to be truthy
  [
    "actor with any org role can revoke",
    orgAdminOrg1,
    { type: "role.revoke", assignmentOwnerId: "u" },
    true,
  ],
  [
    "actor with any dept role can revoke",
    deptMgrDept1a,
    { type: "role.revoke", assignmentOwnerId: "u" },
    true,
  ],
  [
    "actor with only team role cannot revoke",
    teamMgrTeam1a,
    { type: "role.revoke", assignmentOwnerId: "u" },
    false,
  ],
  [
    "super_admin can revoke via global short-circuit",
    superAdmin,
    { type: "role.revoke", assignmentOwnerId: "u" },
    true,
  ],
  // role.grant with scopeType=global (direct, not super_admin) — returns false
  [
    "non-super_admin cannot grant at global scope",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "global",
      scopeId: null,
    },
    false,
  ],
  // role.grant department with inherited org_admin coverage — hits inheritedOrg branch
  [
    "org_admin can grant member at department via inheritance",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "department",
      scopeId: "dept-1a",
    },
    true,
  ],
  // role.grant team with inherited org_admin — hits org_admin inheritance
  // branch inside the team case (lines 141-144)
  [
    "org_admin inheritance elevates rank for team role.grant",
    orgAdminOrg1,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "team_manager",
      scopeType: "team",
      scopeId: "team-1a",
    },
    true,
  ],
  // role.grant team with inherited dept_manager — hits dept_manager
  // inheritance branch (lines 146-150)
  [
    "dept_manager inheritance elevates rank for team role.grant",
    deptMgrDept1a,
    {
      type: "role.grant",
      targetUserId: "u",
      role: "member",
      scopeType: "team",
      scopeId: "team-1a",
    },
    true,
  ],
  // user.read non-self
  [
    "non-admin cannot read another user",
    memberTeam1a,
    { type: "user.read", targetUserId: "someone-else" },
    false,
  ],
  [
    "super_admin can read any user",
    superAdmin,
    { type: "user.read", targetUserId: "anyone" },
    true,
  ],
  // audit.read org-only branch when no deptId supplied
  [
    "org_admin can read org audit",
    orgAdminOrg1,
    { type: "audit.read", orgId: "org-1" },
    true,
  ],
  // Unused orgAdminOrg2 reference, silence unused-var linter via one more case
  [
    "orgAdminOrg2 sanity: can update org-2",
    orgAdminOrg2,
    { type: "org.update", orgId: "org-2" },
    true,
  ],
  // Use deptMgrDept1b too
  [
    "dept_manager of dept-1b can update team-1b",
    deptMgrDept1b,
    { type: "team.update", teamId: "team-1b" },
    true,
  ],
];

describe("can() — permit/forbid matrix", () => {
  it.each([...cases, ...crossBoundaryCases, ...extraCoverageCases])(
    "%s",
    (_, perm, action, expected) => {
      expect(can(perm, action)).toBe(expected);
    },
  );
});

describe("api_key.revoke — ownership and org_admin policy", () => {
  const revokeAction = (ownerUserId: string, orgId = "org-1"): Action => ({
    type: "api_key.revoke",
    apiKeyId: "key-abc",
    orgId,
    ownerUserId,
  });

  it("random user (no role, not owner) → false", () => {
    const randomUser = makePerm([], {});
    expect(can(randomUser, revokeAction("someone-else"))).toBe(false);
  });

  it("owner user (ownerUserId === perm.userId) → true", () => {
    // makePerm sets userId to "actor-1"
    const owner = makePerm([], {});
    expect(can(owner, revokeAction("actor-1"))).toBe(true);
  });

  it("org_admin at the same orgId → true", () => {
    expect(can(orgAdminOrg1, revokeAction("someone-else", "org-1"))).toBe(true);
  });

  it("org_admin at a DIFFERENT orgId → false", () => {
    // orgAdminOrg1 is admin of org-1, not org-2
    expect(can(orgAdminOrg1, revokeAction("someone-else", "org-2"))).toBe(
      false,
    );
  });

  it("super_admin → true (global short-circuit)", () => {
    expect(can(superAdmin, revokeAction("someone-else", "org-1"))).toBe(true);
  });
});

describe("api_key.evaluate_as_project_set — ownership and org_admin policy", () => {
  const setAction = (ownerUserId: string, orgId = "org-1"): Action => ({
    type: "api_key.evaluate_as_project_set",
    apiKeyId: "key-abc",
    orgId,
    ownerUserId,
  });

  it("random user (no role, not owner) → false", () => {
    const randomUser = makePerm([], {});
    expect(can(randomUser, setAction("someone-else"))).toBe(false);
  });

  it("owner user (ownerUserId === perm.userId) → true (self opt-in)", () => {
    const owner = makePerm([], {});
    expect(can(owner, setAction("actor-1"))).toBe(true);
  });

  it("org_admin at the same orgId → true", () => {
    expect(can(orgAdminOrg1, setAction("someone-else", "org-1"))).toBe(true);
  });

  it("org_admin at a DIFFERENT orgId → false", () => {
    expect(can(orgAdminOrg1, setAction("someone-else", "org-2"))).toBe(false);
  });

  it("super_admin → true (global short-circuit)", () => {
    expect(can(superAdmin, setAction("someone-else", "org-1"))).toBe(true);
  });
});
