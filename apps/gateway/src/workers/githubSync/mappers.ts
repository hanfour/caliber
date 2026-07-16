/**
 * Pure GitHub-API → insert-row mappers (PR1, spec 2026-07-15).
 * No I/O; fully unit-testable. All functions return NEW objects.
 */
import type {
  githubPullRequests,
  githubReviews,
  githubIssues,
  githubProjectItems,
} from "@caliber/db";
import type {
  GithubApiPullDetail,
  GithubApiReview,
  GithubApiIssue,
} from "./githubClient.js";

export type NewGithubPullRequest = typeof githubPullRequests.$inferInsert;
export type NewGithubReview = typeof githubReviews.$inferInsert;
export type NewGithubIssue = typeof githubIssues.$inferInsert;
export type NewGithubProjectItem = typeof githubProjectItems.$inferInsert;

/** Spec: Projects v2 terminal statuses (heuristic; documented limitation). */
export const DONE_STATUS_REGEX = /^(done|completed?|shipped|closed)$/i;

export function mapPullRow(input: {
  orgId: string;
  repoFullName: string;
  pull: GithubApiPullDetail;
}): NewGithubPullRequest {
  const { orgId, repoFullName, pull } = input;
  return {
    orgId,
    repoFullName,
    number: pull.number,
    ghNodeId: pull.node_id,
    authorGhId: pull.user?.id ?? null,
    authorLogin: pull.user?.login ?? null,
    state: pull.state,
    draft: pull.draft ?? false,
    title: pull.title,
    htmlUrl: pull.html_url,
    baseRef: pull.base.ref,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    commitCount: pull.commits,
    reviewCommentCount: pull.review_comments,
    ghCreatedAt: new Date(pull.created_at),
    mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
    closedAt: pull.closed_at ? new Date(pull.closed_at) : null,
  };
}

export function mapReviewRows(input: {
  orgId: string;
  repoFullName: string;
  prGhNodeId: string;
  reviews: GithubApiReview[];
}): NewGithubReview[] {
  return input.reviews
    .filter((r) => r.state !== "PENDING" && r.submitted_at !== null)
    .map((r) => ({
      orgId: input.orgId,
      repoFullName: input.repoFullName,
      ghNodeId: r.node_id,
      prGhNodeId: input.prGhNodeId,
      reviewerGhId: r.user?.id ?? null,
      reviewerLogin: r.user?.login ?? null,
      state: r.state,
      // non-null: filtered above
      submittedAt: new Date(r.submitted_at as string),
    }));
}

export function mapIssueRow(input: {
  orgId: string;
  repoFullName: string;
  issue: GithubApiIssue;
}): NewGithubIssue {
  const { orgId, repoFullName, issue } = input;
  return {
    orgId,
    repoFullName,
    number: issue.number,
    ghNodeId: issue.node_id,
    authorGhId: issue.user?.id ?? null,
    authorLogin: issue.user?.login ?? null,
    assigneeGhIds: (issue.assignees ?? []).map((a) => a.id),
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    closedByGhId: issue.closed_by?.id ?? null,
    title: issue.title,
    htmlUrl: issue.html_url,
    ghCreatedAt: new Date(issue.created_at),
    closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
  };
}

/** Normalized Projects-v2 item (Task 11 flattens the GraphQL response to this). */
export interface GithubProjectItemNode {
  itemNodeId: string;
  projectNodeId: string;
  projectTitle: string;
  contentType: string;
  contentGhNodeId: string | null;
  assigneeGhIds: number[];
  statusValue: string | null;
  ghUpdatedAt: string;
}

export function mapProjectItemRow(input: {
  orgId: string;
  node: GithubProjectItemNode;
}): NewGithubProjectItem {
  const { orgId, node } = input;
  return {
    orgId,
    projectNodeId: node.projectNodeId,
    projectTitle: node.projectTitle,
    itemNodeId: node.itemNodeId,
    contentType: node.contentType,
    contentGhNodeId: node.contentGhNodeId,
    assigneeGhIds: node.assigneeGhIds,
    statusValue: node.statusValue,
    isDone: node.statusValue !== null && DONE_STATUS_REGEX.test(node.statusValue),
    ghUpdatedAt: new Date(node.ghUpdatedAt),
  };
}
