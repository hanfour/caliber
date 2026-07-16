/** Incremental-sync watermarks (PR1). One row per (org, repo, resource). */
import { and, eq } from "drizzle-orm";
import { githubSyncState } from "@caliber/db";
import type { Database } from "@caliber/db";

export type GithubResourceType = "pulls" | "issues" | "projects";

export async function getWatermark(
  db: Database,
  orgId: string,
  repoFullName: string,
  resourceType: GithubResourceType,
): Promise<Date | null> {
  const rows = await db
    .select({ watermark: githubSyncState.watermark })
    .from(githubSyncState)
    .where(
      and(
        eq(githubSyncState.orgId, orgId),
        eq(githubSyncState.repoFullName, repoFullName),
        eq(githubSyncState.resourceType, resourceType),
      ),
    )
    .limit(1);
  return rows[0]?.watermark ?? null;
}

export async function setWatermark(
  db: Database,
  input: {
    orgId: string;
    repoFullName: string;
    resourceType: GithubResourceType;
    watermark: Date;
  },
): Promise<void> {
  await db
    .insert(githubSyncState)
    .values({
      orgId: input.orgId,
      repoFullName: input.repoFullName,
      resourceType: input.resourceType,
      watermark: input.watermark,
    })
    .onConflictDoUpdate({
      target: [
        githubSyncState.orgId,
        githubSyncState.repoFullName,
        githubSyncState.resourceType,
      ],
      set: { watermark: input.watermark, updatedAt: new Date() },
    });
}
