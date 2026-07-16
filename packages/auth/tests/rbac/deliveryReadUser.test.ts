import { describe, it, expect } from "vitest";
import { can } from "../../src/rbac/check.js";
import type { UserPermissions } from "../../src/rbac/permissions.js";
import type { Role, ScopeType } from "../../src/rbac/actions.js";

function makePerm(
  rows: ReadonlyArray<{
    role: Role;
    scopeType: ScopeType;
    scopeId: string | null;
  }>,
  userId = "actor-1",
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
    userId,
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
    coveredOrgs: new Set(),
    coveredDepts: new Set(),
    coveredTeams: new Set(),
    deptOrgById: new Map(),
    teamOrgById: new Map(),
    teamDeptById: new Map(),
  };
}

describe("delivery.read_user", () => {
  it("allows self-access regardless of role", () => {
    const perm = makePerm([{ role: "member", scopeType: "organization", scopeId: "org-1" }], "user-A");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-A" })).toBe(true);
  });

  it("allows org_admin of the same org for another user", () => {
    const perm = makePerm([{ role: "org_admin", scopeType: "organization", scopeId: "org-1" }], "admin-1");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(true);
  });

  it("denies a plain member reading another user", () => {
    const perm = makePerm([{ role: "member", scopeType: "organization", scopeId: "org-1" }], "user-A");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(false);
  });

  it("denies org_admin of a different org", () => {
    const perm = makePerm([{ role: "org_admin", scopeType: "organization", scopeId: "org-2" }], "admin-1");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(false);
  });
});
