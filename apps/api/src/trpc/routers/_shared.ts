import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { teams } from "@caliber/db";
import type { Database } from "@caliber/db";

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
