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

describe("request.replay", () => {
  it("本人可重放自己的請求", () => {
    const perm = makePerm([], "u1");
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(true);
  });

  it("org_admin 可重放組織內他人的請求", () => {
    const perm = makePerm([{ role: "org_admin", scopeType: "organization", scopeId: "o1" }], "admin");
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(true);
  });

  it("一般成員不可重放他人的請求", () => {
    const perm = makePerm([], "u2");
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(false);
  });

  it("team_manager 不足以重放——需解密他人 prompt 全文，故僅限 org_admin", () => {
    const perm = makePerm([{ role: "team_manager", scopeType: "team", scopeId: "t1" }], "tm");
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(false);
  });
});
