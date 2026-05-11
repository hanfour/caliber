import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { upstreamAccounts } from "@caliber/db";
import type { Database } from "@caliber/db";

export interface SelectAccountInput {
  orgId: string;
  teamId: string | null;
  excludeIds?: string[];
  limit?: number;
}

export interface SelectedAccount {
  id: string;
  concurrency: number;
}

export async function selectAccounts(
  db: Database,
  input: SelectAccountInput,
): Promise<SelectedAccount[]> {
  const limit = input.limit ?? 5;
  const exclude = input.excludeIds ?? [];
  const now = new Date();

  // When teamId is provided: allow team-scoped (teamId = ?) OR org-level (teamId IS NULL).
  // When teamId is null: only org-level accounts.
  const teamPredicate = input.teamId
    ? or(
        eq(upstreamAccounts.teamId, input.teamId),
        isNull(upstreamAccounts.teamId),
      )
    : isNull(upstreamAccounts.teamId);

  const conditions = [
    eq(upstreamAccounts.orgId, input.orgId),
    teamPredicate,
    isNull(upstreamAccounts.deletedAt),
    eq(upstreamAccounts.schedulable, true),
    eq(upstreamAccounts.status, "active"),
    // Never rate-limited OR rate-limit window has passed
    or(
      isNull(upstreamAccounts.rateLimitedAt),
      lt(upstreamAccounts.rateLimitResetAt, now),
    ),
    // Not overloaded OR overload window has passed
    or(
      isNull(upstreamAccounts.overloadUntil),
      lt(upstreamAccounts.overloadUntil, now),
    ),
    // Not temporarily unschedulable OR window has passed
    or(
      isNull(upstreamAccounts.tempUnschedulableUntil),
      lt(upstreamAccounts.tempUnschedulableUntil, now),
    ),
  ] as Parameters<typeof and>;

  if (exclude.length > 0) {
    conditions.push(notInArray(upstreamAccounts.id, exclude));
  }

  return db
    .select({
      id: upstreamAccounts.id,
      concurrency: upstreamAccounts.concurrency,
    })
    .from(upstreamAccounts)
    .where(and(...conditions))
    .orderBy(
      // Team-scoped accounts (teamId IS NOT NULL → false → sorts first) before org-level (NULL → true)
      sql`(${upstreamAccounts.teamId} IS NULL) ASC`,
      asc(upstreamAccounts.priority),
      // NULLS FIRST: accounts never used come before recently-used ones
      sql`${upstreamAccounts.lastUsedAt} ASC NULLS FIRST`,
    )
    .limit(limit);
}
