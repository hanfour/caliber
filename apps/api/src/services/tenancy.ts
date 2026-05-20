import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizationMembers, departments, teams } from "@caliber/db";
import type { ScopeType } from "@caliber/auth";
import { ServiceError } from "../trpc/errors.js";

// Tenancy assertions enforce that role/invite/team writes can never cross
// organization boundaries. role_assignments has no org_id column, so the
// invariant is service-layer enforced rather than schema-enforced.

// Match the AuditDb union from services/audit.ts so callers can pass either
// the root Database or a transaction handle (the narrower type drizzle hands
// to transaction callbacks). Without this, acceptInvite cannot validate
// inside its `db.transaction(...)` block.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type TenancyDb = Database | Tx;

export async function assertUserMemberOfOrg(
  db: TenancyDb,
  userId: string,
  orgId: string,
): Promise<void> {
  const [row] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ServiceError(
      "FORBIDDEN",
      "user is not a member of the target organization",
    );
  }
}

export async function assertDepartmentBelongsToOrg(
  db: TenancyDb,
  departmentId: string,
  orgId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(
        eq(departments.id, departmentId),
        eq(departments.orgId, orgId),
        isNull(departments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ServiceError(
      "BAD_REQUEST",
      "department does not belong to the target organization",
    );
  }
}

export async function assertTeamBelongsToOrg(
  db: TenancyDb,
  teamId: string,
  orgId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.id, teamId),
        eq(teams.orgId, orgId),
        isNull(teams.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ServiceError(
      "BAD_REQUEST",
      "team does not belong to the target organization",
    );
  }
}

// Assert a (scopeType, scopeId) tuple is coherent with the target orgId.
// 'global' is a no-op (org-agnostic). 'organization' requires scopeId === orgId.
// 'department' / 'team' delegate to the corresponding belongs-to check.
export async function assertScopeBelongsToOrg(
  db: TenancyDb,
  scopeType: ScopeType,
  scopeId: string | null,
  orgId: string,
): Promise<void> {
  switch (scopeType) {
    case "global":
      return;
    case "organization":
      if (!scopeId) {
        throw new ServiceError(
          "BAD_REQUEST",
          "organization scope requires a scopeId",
        );
      }
      if (scopeId !== orgId) {
        throw new ServiceError(
          "BAD_REQUEST",
          "scopeId does not match the target organization",
        );
      }
      return;
    case "department":
      if (!scopeId) {
        throw new ServiceError(
          "BAD_REQUEST",
          "department scope requires a scopeId",
        );
      }
      await assertDepartmentBelongsToOrg(db, scopeId, orgId);
      return;
    case "team":
      if (!scopeId) {
        throw new ServiceError("BAD_REQUEST", "team scope requires a scopeId");
      }
      await assertTeamBelongsToOrg(db, scopeId, orgId);
      return;
  }
}

// Resolve the implied orgId for a (scopeType, scopeId). Returns null for
// global scope (org-agnostic). Throws if the underlying row is missing or
// a non-global scope is missing its scopeId.
export async function resolveScopeOrgId(
  db: TenancyDb,
  scopeType: ScopeType,
  scopeId: string | null,
): Promise<string | null> {
  switch (scopeType) {
    case "global":
      return null;
    case "organization":
      if (!scopeId) {
        throw new ServiceError(
          "BAD_REQUEST",
          "organization scope requires a scopeId",
        );
      }
      return scopeId;
    case "department": {
      if (!scopeId) {
        throw new ServiceError(
          "BAD_REQUEST",
          "department scope requires a scopeId",
        );
      }
      const [row] = await db
        .select({ orgId: departments.orgId })
        .from(departments)
        .where(
          and(eq(departments.id, scopeId), isNull(departments.deletedAt)),
        )
        .limit(1);
      if (!row) throw new ServiceError("NOT_FOUND", "department not found");
      return row.orgId;
    }
    case "team": {
      if (!scopeId) {
        throw new ServiceError("BAD_REQUEST", "team scope requires a scopeId");
      }
      const [row] = await db
        .select({ orgId: teams.orgId })
        .from(teams)
        .where(and(eq(teams.id, scopeId), isNull(teams.deletedAt)))
        .limit(1);
      if (!row) throw new ServiceError("NOT_FOUND", "team not found");
      return row.orgId;
    }
  }
}
