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

// A plain member with no special roles
const member = makePerm(
  [{ role: "member", scopeType: "team", scopeId: "team-1a" }],
  "actor-1",
);

// A super_admin for break-glass verification
const superAdmin = makePerm(
  [{ role: "super_admin", scopeType: "global", scopeId: null }],
  "super-user",
);

describe("account.register_own", () => {
  it("any authenticated member may register their own upstream", () => {
    expect(can(member, { type: "account.register_own" })).toBe(true);
  });

  it("super_admin may also register (break-glass short-circuit)", () => {
    expect(can(superAdmin, { type: "account.register_own" })).toBe(true);
  });

  it("even a principal with no roles may register (any authenticated = true)", () => {
    const noRole = makePerm([], "bare-user");
    expect(can(noRole, { type: "account.register_own" })).toBe(true);
  });
});

describe("account.manage_own", () => {
  it("a member may manage an upstream they own", () => {
    expect(
      can(member, { type: "account.manage_own", ownerUserId: member.userId }),
    ).toBe(true);
  });

  it("a member may NOT manage an upstream owned by someone else", () => {
    expect(
      can(member, { type: "account.manage_own", ownerUserId: "someone-else" }),
    ).toBe(false);
  });

  it("super_admin may manage any upstream (break-glass short-circuit)", () => {
    expect(
      can(superAdmin, {
        type: "account.manage_own",
        ownerUserId: "someone-else",
      }),
    ).toBe(true);
  });

  it("an org_admin is denied manage_own on another user's upstream (no bypass; only super_admin)", () => {
    const orgAdmin = makePerm(
      [{ role: "org_admin", scopeType: "organization", scopeId: "org1" }],
      "admin-1",
    );
    expect(
      can(orgAdmin, { type: "account.manage_own", ownerUserId: "someone-else" }),
    ).toBe(false);
  });
});
