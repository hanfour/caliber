/**
 * Issue sync for one repo (PR1, spec 2026-07-15). Incremental via the
 * 'issues' watermark (the REST issues list supports ?since=updated).
 * List payloads omit closed_by, so closed issues cost one extra detail
 * GET each — bounded by the watermark window.
 */
import { githubIssues } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { GithubClient } from "./githubClient.js";
import { mapIssueRow } from "./mappers.js";
import { getWatermark, setWatermark } from "./watermarks.js";

export interface SyncRepoIssuesInput {
  db: Database;
  client: GithubClient;
  orgId: string;
  repoFullName: string;
}

export async function syncRepoIssues(
  input: SyncRepoIssuesInput,
): Promise<{ issues: number }> {
  const { db, client, orgId, repoFullName } = input;
  const since = await getWatermark(db, orgId, repoFullName, "issues");
  const items = await client.listIssuesSince(
    repoFullName,
    since ? since.toISOString() : null,
  );

  let maxUpdated: string | null = null;

  for (const item of items) {
    const issue =
      item.state === "closed" && item.closed_by === undefined
        ? await client.getIssue(repoFullName, item.number)
        : item;
    const row = mapIssueRow({ orgId, repoFullName, issue });
    await db
      .insert(githubIssues)
      .values(row)
      .onConflictDoUpdate({
        target: [githubIssues.orgId, githubIssues.ghNodeId],
        set: {
          state: row.state,
          stateReason: row.stateReason,
          assigneeGhIds: row.assigneeGhIds,
          closedByGhId: row.closedByGhId,
          title: row.title,
          closedAt: row.closedAt,
          syncedAt: new Date(),
        },
      });
    if (maxUpdated === null || item.updated_at > maxUpdated) {
      maxUpdated = item.updated_at;
    }
  }

  if (maxUpdated !== null) {
    await setWatermark(db, {
      orgId,
      repoFullName,
      resourceType: "issues",
      watermark: new Date(maxUpdated),
    });
  }
  return { issues: items.length };
}
