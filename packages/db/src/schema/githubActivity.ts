import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

/**
 * Synced GitHub activity metadata (PR1, spec 2026-07-15).
 * Attribution joins author_gh_id::text = accounts.provider_account_id
 * (provider = 'github'). Diff/patch content is NEVER stored.
 * All four tables upsert on (org_id, <node id>).
 */
export const githubPullRequests = pgTable(
  "github_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    ghNodeId: text("gh_node_id").notNull(),
    // NULL when the author account was deleted (GitHub "ghost").
    authorGhId: bigint("author_gh_id", { mode: "number" }),
    authorLogin: text("author_login"),
    state: text("state").notNull(), // 'open' | 'closed'
    draft: boolean("draft").notNull().default(false),
    title: text("title").notNull(),
    htmlUrl: text("html_url").notNull(),
    baseRef: text("base_ref").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFiles: integer("changed_files").notNull().default(0),
    commitCount: integer("commit_count").notNull().default(0),
    reviewCommentCount: integer("review_comment_count").notNull().default(0),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNodeUniq: uniqueIndex("github_pull_requests_org_node_uniq").on(
      t.orgId,
      t.ghNodeId,
    ),
    orgAuthorIdx: index("github_pull_requests_org_author_idx").on(
      t.orgId,
      t.authorGhId,
    ),
    orgMergedIdx: index("github_pull_requests_org_merged_idx").on(
      t.orgId,
      t.mergedAt,
    ),
  }),
);

export const githubReviews = pgTable(
  "github_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    ghNodeId: text("gh_node_id").notNull(),
    prGhNodeId: text("pr_gh_node_id").notNull(),
    reviewerGhId: bigint("reviewer_gh_id", { mode: "number" }),
    reviewerLogin: text("reviewer_login"),
    // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
    // (PENDING reviews are filtered out by the mapper.)
    state: text("state").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNodeUniq: uniqueIndex("github_reviews_org_node_uniq").on(
      t.orgId,
      t.ghNodeId,
    ),
    orgReviewerIdx: index("github_reviews_org_reviewer_idx").on(
      t.orgId,
      t.reviewerGhId,
    ),
  }),
);

export const githubIssues = pgTable(
  "github_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    ghNodeId: text("gh_node_id").notNull(),
    authorGhId: bigint("author_gh_id", { mode: "number" }),
    authorLogin: text("author_login"),
    // number[] of GitHub user ids.
    assigneeGhIds: jsonb("assignee_gh_ids").notNull(),
    state: text("state").notNull(), // 'open' | 'closed'
    stateReason: text("state_reason"), // 'completed' | 'not_planned' | ...
    closedByGhId: bigint("closed_by_gh_id", { mode: "number" }),
    title: text("title").notNull(),
    htmlUrl: text("html_url").notNull(),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNodeUniq: uniqueIndex("github_issues_org_node_uniq").on(
      t.orgId,
      t.ghNodeId,
    ),
    orgAuthorIdx: index("github_issues_org_author_idx").on(
      t.orgId,
      t.authorGhId,
    ),
    orgClosedIdx: index("github_issues_org_closed_idx").on(
      t.orgId,
      t.closedAt,
    ),
  }),
);

export const githubProjectItems = pgTable(
  "github_project_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectNodeId: text("project_node_id").notNull(),
    projectTitle: text("project_title").notNull(),
    itemNodeId: text("item_node_id").notNull(),
    contentType: text("content_type").notNull(), // 'ISSUE'|'PULL_REQUEST'|'DRAFT_ISSUE'
    contentGhNodeId: text("content_gh_node_id"),
    // number[] of GitHub user ids.
    assigneeGhIds: jsonb("assignee_gh_ids").notNull(),
    statusValue: text("status_value"),
    // Projects v2 has no completed_at; is_done flips when the Status
    // single-select matches /^(done|completed?|shipped|closed)$/i and we
    // record gh_updated_at as the proxy completion time (spec limitation).
    isDone: boolean("is_done").notNull().default(false),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgItemUniq: uniqueIndex("github_project_items_org_item_uniq").on(
      t.orgId,
      t.itemNodeId,
    ),
    orgDoneIdx: index("github_project_items_org_done_idx").on(
      t.orgId,
      t.isDone,
    ),
  }),
);
