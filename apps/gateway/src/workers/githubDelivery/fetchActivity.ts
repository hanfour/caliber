/**
 * Attribution + activity fetch for delivery scoring (PR2).
 * SQL narrows by org/window/indexed author columns; jsonb assignee
 * membership and closedBy-OR-assignee logic stay in the pure metric
 * layer (already unit-tested there). assigneeGhIds jsonb is sanitized —
 * never trusted as number[].
 */
import { and, eq, gte, lte, isNotNull } from "drizzle-orm";
import {
  accounts,
  githubIssues,
  githubProjectItems,
  githubPullRequests,
  githubReviews,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import type {
  DeliveryIssueInput,
  DeliveryProjectItemInput,
  DeliveryPullInput,
  DeliveryReviewInput,
} from "@caliber/evaluator";

export async function resolveGithubUserId(
  db: Database,
  userId: string,
): Promise<number | null> {
  const row = (
    await db
      .select({ providerAccountId: accounts.providerAccountId })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")))
      .limit(1)
  )[0];
  if (!row) return null;
  const ghId = Number(row.providerAccountId);
  return Number.isFinite(ghId) ? ghId : null;
}

function sanitizeGhIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
}

export interface DeliveryActivity {
  pulls: DeliveryPullInput[];
  reviews: DeliveryReviewInput[];
  issues: DeliveryIssueInput[];
  projectItems: DeliveryProjectItemInput[];
}

export async function fetchDeliveryActivity(
  db: Database,
  input: { orgId: string; ghUserId: number; window: { start: Date; end: Date } },
): Promise<DeliveryActivity> {
  const { orgId, ghUserId, window } = input;

  const pullRows = await db
    .select({
      ghNodeId: githubPullRequests.ghNodeId,
      authorGhId: githubPullRequests.authorGhId,
      draft: githubPullRequests.draft,
      ghCreatedAt: githubPullRequests.ghCreatedAt,
      mergedAt: githubPullRequests.mergedAt,
    })
    .from(githubPullRequests)
    .where(
      and(
        eq(githubPullRequests.orgId, orgId),
        eq(githubPullRequests.authorGhId, ghUserId),
        isNotNull(githubPullRequests.mergedAt),
        gte(githubPullRequests.mergedAt, window.start),
        lte(githubPullRequests.mergedAt, window.end),
      ),
    );

  const reviewRows = await db
    .select({
      reviewerGhId: githubReviews.reviewerGhId,
      prGhNodeId: githubReviews.prGhNodeId,
      submittedAt: githubReviews.submittedAt,
      prAuthorGhId: githubPullRequests.authorGhId,
    })
    .from(githubReviews)
    .leftJoin(
      githubPullRequests,
      and(
        eq(githubPullRequests.orgId, githubReviews.orgId),
        eq(githubPullRequests.ghNodeId, githubReviews.prGhNodeId),
      ),
    )
    .where(
      and(
        eq(githubReviews.orgId, orgId),
        eq(githubReviews.reviewerGhId, ghUserId),
        gte(githubReviews.submittedAt, window.start),
        lte(githubReviews.submittedAt, window.end),
      ),
    );

  const issueRows = await db
    .select({
      assigneeGhIds: githubIssues.assigneeGhIds,
      closedByGhId: githubIssues.closedByGhId,
      ghCreatedAt: githubIssues.ghCreatedAt,
      closedAt: githubIssues.closedAt,
    })
    .from(githubIssues)
    .where(
      and(
        eq(githubIssues.orgId, orgId),
        isNotNull(githubIssues.closedAt),
        gte(githubIssues.closedAt, window.start),
        lte(githubIssues.closedAt, window.end),
      ),
    );

  const itemRows = await db
    .select({
      assigneeGhIds: githubProjectItems.assigneeGhIds,
      isDone: githubProjectItems.isDone,
      ghUpdatedAt: githubProjectItems.ghUpdatedAt,
    })
    .from(githubProjectItems)
    .where(
      and(
        eq(githubProjectItems.orgId, orgId),
        eq(githubProjectItems.isDone, true),
        gte(githubProjectItems.ghUpdatedAt, window.start),
        lte(githubProjectItems.ghUpdatedAt, window.end),
      ),
    );

  return {
    pulls: pullRows.map((r) => ({
      ghNodeId: r.ghNodeId,
      authorGhId: r.authorGhId,
      draft: r.draft,
      ghCreatedAt: r.ghCreatedAt,
      mergedAt: r.mergedAt,
    })),
    reviews: reviewRows.map((r) => ({
      reviewerGhId: r.reviewerGhId,
      prGhNodeId: r.prGhNodeId,
      prAuthorGhId: r.prAuthorGhId ?? null,
      submittedAt: r.submittedAt,
    })),
    issues: issueRows.map((r) => ({
      assigneeGhIds: sanitizeGhIds(r.assigneeGhIds),
      closedByGhId: r.closedByGhId,
      ghCreatedAt: r.ghCreatedAt,
      closedAt: r.closedAt,
    })),
    projectItems: itemRows.map((r) => ({
      assigneeGhIds: sanitizeGhIds(r.assigneeGhIds),
      isDone: r.isDone,
      ghUpdatedAt: r.ghUpdatedAt,
    })),
  };
}
