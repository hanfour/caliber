import { describe, it, expect } from "vitest";
import { can } from "../../../src/rbac/check.js";
import type { UserPermissions } from "../../../src/rbac/permissions.js";
import type { Role, ScopeType } from "../../../src/rbac/actions.js";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000002";
const API_KEY_ID = "key-abc";
const OWNER_USER_ID = "owner-user";
const OTHER_USER_ID = "other-user";

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
  };
}

// Fixtures
const owner = makePerm(
  [{ role: "member", scopeType: "organization", scopeId: ORG_ID }],
  OWNER_USER_ID,
);

const orgAdmin = makePerm(
  [{ role: "org_admin", scopeType: "organization", scopeId: ORG_ID }],
  "admin-user",
);

const crossOrgAdmin = makePerm(
  [{ role: "org_admin", scopeType: "organization", scopeId: OTHER_ORG_ID }],
  "cross-admin-user",
);

const otherMember = makePerm(
  [{ role: "member", scopeType: "organization", scopeId: ORG_ID }],
  OTHER_USER_ID,
);

const superAdmin = makePerm(
  [{ role: "super_admin", scopeType: "global", scopeId: null }],
  "super-user",
);

const ACTIONS = ["rubric.read_key", "rubric.author_key", "rubric.delete_key"] as const;
type RubricKeyActionType = (typeof ACTIONS)[number];

function makeAction(type: RubricKeyActionType) {
  return {
    type,
    apiKeyId: API_KEY_ID,
    orgId: ORG_ID,
    ownerUserId: OWNER_USER_ID,
  } as const;
}

for (const actionType of ACTIONS) {
  describe(`RBAC: ${actionType}`, () => {
    it("key owner (ownerUserId === caller) is allowed", () => {
      expect(can(owner, makeAction(actionType))).toBe(true);
    });

    it("org_admin of the same org is allowed", () => {
      expect(can(orgAdmin, makeAction(actionType))).toBe(true);
    });

    it("a different member (not owner, not admin) is denied", () => {
      expect(can(otherMember, makeAction(actionType))).toBe(false);
    });

    it("an org_admin of a different org is denied", () => {
      expect(can(crossOrgAdmin, makeAction(actionType))).toBe(false);
    });

    it("super_admin is allowed (break-glass short-circuit)", () => {
      expect(can(superAdmin, makeAction(actionType))).toBe(true);
    });
  });
}
