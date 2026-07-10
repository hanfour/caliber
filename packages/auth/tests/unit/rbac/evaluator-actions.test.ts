import { describe, it, expect } from "vitest";
import { can } from "../../../src/rbac/check";
import type { UserPermissions } from "../../../src/rbac/permissions";
import type { Action, Role, ScopeType } from "../../../src/rbac/actions";

describe("RBAC — evaluator actions", () => {
  it("compiles with new capture / rubric / report / evaluator variants", () => {
    const samples: Action[] = [
      { type: "content_capture.read", orgId: "x" },
      { type: "content_capture.toggle", orgId: "x" },
      { type: "report.read_own" },
      { type: "report.read_user", orgId: "x", targetUserId: "u" },
      { type: "report.read_team", orgId: "x", teamId: "t" },
      { type: "report.read_org", orgId: "x" },
      {
        type: "report.rerun",
        orgId: "x",
        targetUserId: "u",
        periodStart: "2026-04-22",
      },
      { type: "report.export_own" },
      { type: "report.delete_own" },
      { type: "rubric.read", orgId: "x" },
      { type: "rubric.create", orgId: "x" },
      { type: "rubric.update", orgId: "x", rubricId: "r" },
      { type: "rubric.delete", orgId: "x", rubricId: "r" },
      { type: "evaluator.read_status", orgId: "x" },
      { type: "evaluator.view_cost", orgId: "x" },
    ];
    expect(samples.length).toBe(15);
  });
});

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
    deptOrgById: new Map(),
    teamOrgById: new Map(),
    teamDeptById: new Map(),
  };
}

describe("RBAC: evaluator.view_cost", () => {
  const orgId = "00000000-0000-0000-0000-000000000001";
  const otherOrgId = "00000000-0000-0000-0000-000000000002";

  it("super_admin can view cost for any org", () => {
    const perm = makePerm([
      { role: "super_admin", scopeType: "global", scopeId: null },
    ]);
    expect(can(perm, { type: "evaluator.view_cost", orgId })).toBe(true);
  });

  it("org_admin of the same org can view cost", () => {
    const perm = makePerm(
      [{ role: "org_admin", scopeType: "organization", scopeId: orgId }],
      { orgs: [orgId] },
    );
    expect(can(perm, { type: "evaluator.view_cost", orgId })).toBe(true);
  });

  it("org_admin of a different org cannot view cost", () => {
    const perm = makePerm(
      [{ role: "org_admin", scopeType: "organization", scopeId: otherOrgId }],
      { orgs: [otherOrgId] },
    );
    expect(can(perm, { type: "evaluator.view_cost", orgId })).toBe(false);
  });

  it("member cannot view cost", () => {
    const perm = makePerm(
      [{ role: "member", scopeType: "team", scopeId: "team-1a" }],
      { teams: ["team-1a"] },
    );
    expect(can(perm, { type: "evaluator.view_cost", orgId })).toBe(false);
  });
});
