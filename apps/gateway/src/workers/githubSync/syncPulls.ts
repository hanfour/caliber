/**
 * PR + review sync for one repo (PR1, spec 2026-07-15).
 * Incremental via the 'pulls' watermark (= max updated_at seen).
 * Upserts on (org_id, gh_node_id); reviews ride along per PR.
 */
import { githubPullRequests, githubReviews } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { GithubClient } from "./githubClient.js";
import { mapPullRow, mapReviewRows } from "./mappers.js";
import { getWatermark, setWatermark } from "./watermarks.js";

export interface SyncRepoPullsInput {
  db: Database;
  client: GithubClient;
  orgId: string;
  repoFullName: string;
}

export async function syncRepoPulls(
  input: SyncRepoPullsInput,
): Promise<{ pulls: number; reviews: number }> {
  const { db, client, orgId, repoFullName } = input;
  const since = await getWatermark(db, orgId, repoFullName, "pulls");
  const items = await client.listPullsSince(
    repoFullName,
    since ? since.toISOString() : null,
  );

  let reviews = 0;
  let maxUpdated: string | null = null;

  for (const item of items) {
    const detail = await client.getPull(repoFullName, item.number);
    const prRow = mapPullRow({ orgId, repoFullName, pull: detail });
    await db
      .insert(githubPullRequests)
      .values(prRow)
      .onConflictDoUpdate({
        target: [githubPullRequests.orgId, githubPullRequests.ghNodeId],
        set: {
          state: prRow.state,
          draft: prRow.draft,
          title: prRow.title,
          additions: prRow.additions,
          deletions: prRow.deletions,
          changedFiles: prRow.changedFiles,
          commitCount: prRow.commitCount,
          reviewCommentCount: prRow.reviewCommentCount,
          mergedAt: prRow.mergedAt,
          closedAt: prRow.closedAt,
          syncedAt: new Date(),
        },
      });

    const reviewRows = mapReviewRows({
      orgId,
      repoFullName,
      prGhNodeId: detail.node_id,
      reviews: await client.listReviews(repoFullName, item.number),
    });
    for (const row of reviewRows) {
      await db
        .insert(githubReviews)
        .values(row)
        .onConflictDoUpdate({
          target: [githubReviews.orgId, githubReviews.ghNodeId],
          set: { state: row.state, submittedAt: row.submittedAt, syncedAt: new Date() },
        });
    }
    reviews += reviewRows.length;
    if (maxUpdated === null || item.updated_at > maxUpdated) {
      maxUpdated = item.updated_at;
    }
  }

  if (maxUpdated !== null) {
    await setWatermark(db, {
      orgId,
      repoFullName,
      resourceType: "pulls",
      watermark: new Date(maxUpdated),
    });
  }
  return { pulls: items.length, reviews };
}
