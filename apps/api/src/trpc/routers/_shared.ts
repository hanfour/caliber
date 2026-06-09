import { and, asc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { teams, accountGroups, organizationMembers } from "@caliber/db";
import type { Database } from "@caliber/db";

// Gateway feature-gate. Every accounts mutation/query is hidden (NOT_FOUND,
// not FORBIDDEN) when the gateway is disabled so the surface doesn't leak its
// existence to deployments that never enabled it.
export function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }): void {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Cross-tenant integrity guard. `api_keys.team_id` and
// `upstream_accounts.team_id` are independent FKs to the `teams` table — the
// schema does NOT enforce that the row's `org_id` matches the team's
// `org_id`. Without this check, an org-A admin (or member self-issuing) could
// write a row with `org_id=A` AND `team_id=<team in org B>`, corrupting
// team-scoped routing and usage attribution. Call this before INSERT
// whenever a `teamId` input is paired with an `orgId`.
//
// NOT_FOUND for missing/soft-deleted team mirrors the convention used
// elsewhere (don't leak existence on lookups). FORBIDDEN for the cross-org
// case — the team exists, just not in their org, and we know the caller
// already passed RBAC for the org so no leak is involved.
export async function assertTeamBelongsToOrg(
  db: Database,
  teamId: string,
  orgId: string,
): Promise<void> {
  const [team] = await db
    .select({ orgId: teams.orgId })
    .from(teams)
    .where(and(eq(teams.id, teamId), isNull(teams.deletedAt)))
    .limit(1);
  if (!team) {
    throw new TRPCError({ code: "NOT_FOUND", message: "team not found" });
  }
  if (team.orgId !== orgId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "team does not belong to org",
    });
  }
}

// Resolve the primary (earliest-joined) org for a user. Used by self-service
// mutations that don't accept an explicit orgId input. Throws NOT_FOUND if the
// user has no org membership — which should not happen for any real user.
//
// KNOWN LIMITATION: Works while users belong to one org at a time. Once
// multi-org membership lands, callers may need an explicit orgId input to
// disambiguate.
export async function resolveUserPrimaryOrgId(
  db: Database,
  userId: string,
): Promise<string> {
  const [row] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.joinedAt))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "user has no organization membership",
    });
  }
  return row.orgId;
}

// Same cross-tenant integrity guard for `api_keys.group_id` (#191). The column
// is an independent FK to `account_groups`; without this an admin (or member
// self-issuing) could bind a key to a group in another org, steering the
// gateway's platform routing / scheduling across the tenant boundary. Call
// before INSERT whenever a `groupId` input is paired with an `orgId`.
// NOT_FOUND for missing/soft-deleted group; FORBIDDEN for the cross-org case
// (caller already passed RBAC for the org, so no existence leak).
export async function assertGroupBelongsToOrg(
  db: Database,
  groupId: string,
  orgId: string,
): Promise<void> {
  const [group] = await db
    .select({ orgId: accountGroups.orgId })
    .from(accountGroups)
    .where(and(eq(accountGroups.id, groupId), isNull(accountGroups.deletedAt)))
    .limit(1);
  if (!group) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "account group not found",
    });
  }
  if (group.orgId !== orgId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "account group does not belong to org",
    });
  }
}
