/**
 * Projects v2 sync (PR1, spec 2026-07-15). GraphQL-only surface.
 * Requires the PAT to hold org "Projects: read". Full re-upsert per
 * sync (no watermark): item field-value changes don't reliably bump
 * updatedAt filters, and volume is bounded for team-scale orgs.
 */
import { githubProjectItems } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { GithubClient } from "./githubClient.js";
import { mapProjectItemRow, type GithubProjectItemNode } from "./mappers.js";

const PROJECTS_QUERY = `
query($owner: String!, $cursor: String) {
  organization(login: $owner) {
    projectsV2(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
}`;

const PROJECT_ITEMS_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          updatedAt
          content {
            __typename
            ... on Issue { id assignees(first: 10) { nodes { databaseId } } }
            ... on PullRequest { id assignees(first: 10) { nodes { databaseId } } }
            ... on DraftIssue { id }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

interface ProjectsPage {
  organization: {
    projectsV2: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string; title: string }>;
    };
  } | null;
}

interface ItemsPage {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        type: string;
        updatedAt: string;
        content: {
          __typename: string;
          id?: string;
          assignees?: { nodes: Array<{ databaseId: number | null }> };
        } | null;
        fieldValueByName: { name?: string } | null;
      }>;
    };
  } | null;
}

export interface SyncOrgProjectsInput {
  db: Database;
  client: GithubClient;
  orgId: string;
  ownerLogin: string;
}

export async function syncOrgProjects(
  input: SyncOrgProjectsInput,
): Promise<{ projectItems: number }> {
  const { db, client, orgId, ownerLogin } = input;
  let count = 0;

  let projCursor: string | null = null;
  do {
    const page: ProjectsPage = await client.graphql<ProjectsPage>(
      PROJECTS_QUERY,
      { owner: ownerLogin, cursor: projCursor },
    );
    const conn = page.organization?.projectsV2;
    if (!conn) break;

    for (const project of conn.nodes) {
      let itemCursor: string | null = null;
      do {
        const itemsPage: ItemsPage = await client.graphql<ItemsPage>(
          PROJECT_ITEMS_QUERY,
          { projectId: project.id, cursor: itemCursor },
        );
        const items = itemsPage.node?.items;
        if (!items) break;

        for (const raw of items.nodes) {
          const node: GithubProjectItemNode = {
            itemNodeId: raw.id,
            projectNodeId: project.id,
            projectTitle: project.title,
            contentType: raw.type,
            contentGhNodeId: raw.content?.id ?? null,
            assigneeGhIds: (raw.content?.assignees?.nodes ?? [])
              .map((a) => a.databaseId)
              .filter((id): id is number => id !== null),
            statusValue: raw.fieldValueByName?.name ?? null,
            ghUpdatedAt: raw.updatedAt,
          };
          const row = mapProjectItemRow({ orgId, node });
          await db
            .insert(githubProjectItems)
            .values(row)
            .onConflictDoUpdate({
              target: [githubProjectItems.orgId, githubProjectItems.itemNodeId],
              set: {
                projectTitle: row.projectTitle,
                contentType: row.contentType,
                contentGhNodeId: row.contentGhNodeId,
                assigneeGhIds: row.assigneeGhIds,
                statusValue: row.statusValue,
                isDone: row.isDone,
                ghUpdatedAt: row.ghUpdatedAt,
                syncedAt: new Date(),
              },
            });
          count++;
        }
        itemCursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
      } while (itemCursor !== null);
    }
    projCursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (projCursor !== null);

  return { projectItems: count };
}
