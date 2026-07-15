# GitHub Delivery PR 1 — Connection + Sync Worker + Tables — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 1 of the GitHub delivery scoring feature (spec: `docs/superpowers/specs/2026-07-15-github-delivery-scoring-design.md`): org-level GitHub PAT connection (encrypted at rest), a `github-sync` BullMQ worker that ingests PRs/reviews/issues/Projects-v2 items into new tables, and the admin tRPC surface to manage the connection — all dark behind `ENABLE_GITHUB_DELIVERY`.

**Architecture:** Mirrors the evaluator pipeline exactly: Drizzle tables + hand-written migration 0032; a queue module with zod payload + colon-free deterministic jobId; a worker in `apps/gateway/src/workers/githubSync/` with `setInterval`-based scheduling (repo convention — no cron parser); a fetch-based GitHub client with `fetchImpl` DI (no octokit dependency); PAT sealed with `encryptCredential` (AES-256-GCM + HKDF, salt = connection row id); tRPC router gated like `_evaluatorGate.ts`, RBAC via a new `github.manage` action.

**Tech Stack:** TypeScript ESM (`.js` import extensions), Drizzle ORM (postgres), BullMQ + ioredis, zod, vitest (+ `@testcontainers/postgresql`), tRPC v11 patterns already in repo.

## Global Constraints

- Feature flag: `ENABLE_GITHUB_DELIVERY` — `booleanUnion.default(false)` in `packages/config/src/env.ts` (typed env, NOT raw `process.env`).
- Master key env: `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars); API side obtains it via `requireMasterKeyHex(ctx.env)` from `apps/api/src/trpc/routers/_credentials.ts:64`.
- BullMQ jobIds MUST NOT contain `:` — always `.replaceAll(":", "-")` (see `packages/evaluator/src/jobId.ts:8`).
- The PAT must NEVER appear in logs, API responses, or error messages. All error strings surfaced from sync go through `safeErrorMessage` (`packages/gateway-core/src/logging/redact.ts:157`).
- Table names snake_case; index names `<table>_<cols>_idx` / `_uniq`; timestamps always `{ withTimezone: true }`.
- Migrations are hand-written with `--> statement-breakpoint` separators + paired `_down.sql` + a `meta/_journal.json` entry (`idx: 32`, `when: 1783699000003`, `tag: "0032_github_delivery"`). No snapshot file needed.
- Commit format: `<type>(<scope>): <description>` — NO Co-Authored-By trailer (disabled in this repo).
- All work on branch `feat/github-delivery-pr1-sync`.
- Attribution join key: GitHub numeric user id (`accounts.providerAccountId` where `provider = 'github'`); activity rows store BOTH numeric id and login.

---

### Task 1: DB schema files (3 new schema modules + barrel export)

**Files:**
- Create: `packages/db/src/schema/githubConnections.ts`
- Create: `packages/db/src/schema/githubActivity.ts`
- Create: `packages/db/src/schema/githubDeliveryReports.ts`
- Modify: `packages/db/src/schema/index.ts` (append 3 export lines)

**Interfaces:**
- Consumes: `organizations` (`./org.js`), `users` (`./auth.js`), `bytea` customType pattern (copy from `credentialVault.ts:11-15`).
- Produces: exported tables `githubConnections`, `githubSyncState`, `githubPullRequests`, `githubReviews`, `githubIssues`, `githubProjectItems`, `githubDeliveryReports` — later tasks use `typeof githubPullRequests.$inferInsert` etc. via `@caliber/db`.

- [ ] **Step 1: Create branch**

```bash
git checkout -b feat/github-delivery-pr1-sync
```

- [ ] **Step 2: Write `githubConnections.ts`**

```ts
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  customType,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Org-level GitHub connection (PR1, spec 2026-07-15).
 * One fine-grained PAT per org, sealed with AES-256-GCM/HKDF
 * (salt = this row's id — re-encryption on update MUST reuse the row id).
 * The token is write-only: no API path ever returns it.
 */
export const githubConnections = pgTable(
  "github_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // GitHub org (or user) the PAT is scoped to; drives repo listing.
    ownerLogin: text("owner_login").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    tokenLast4: text("token_last4").notNull(),
    // string[] of "owner/repo"; NULL = all repos the PAT can see.
    repoAllowlist: jsonb("repo_allowlist"),
    deliveryEnabled: boolean("delivery_enabled").notNull().default(true),
    // 'ok' | 'auth_error' | 'rate_limited' | 'sync_error'
    status: text("status").notNull().default("ok"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Per-repo, per-resource incremental sync watermark.
 * resourceType: 'pulls' | 'issues' | 'projects' (projects uses
 * repoFullName = '*' — it is org-scoped, not repo-scoped).
 */
export const githubSyncState = pgTable(
  "github_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    resourceType: text("resource_type").notNull(),
    watermark: timestamp("watermark", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgRepoResourceUniq: uniqueIndex(
      "github_sync_state_org_repo_resource_uniq",
    ).on(t.orgId, t.repoFullName, t.resourceType),
  }),
);
```

- [ ] **Step 3: Write `githubActivity.ts`**

```ts
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
```

- [ ] **Step 4: Write `githubDeliveryReports.ts`**

```ts
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  decimal,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";

/**
 * Per-member GitHub delivery report (spec 2026-07-15). Mirrors the shape
 * of evaluation_reports but is a fully independent track — never summed
 * with the AI-usage score. Populated by PR2 (quant) / PR3 (LLM); the table
 * ships in PR1 so migration 0032 is complete.
 * llm_status: 'ok' | 'skipped' | 'parse_error' | 'budget_denied'
 */
export const githubDeliveryReports = pgTable(
  "github_delivery_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    periodType: text("period_type").notNull(),
    totalScore: decimal("total_score", { precision: 10, scale: 4 }),
    insufficientData: boolean("insufficient_data").notNull().default(false),
    sectionScores: jsonb("section_scores").notNull(),
    // Raw counts + curve inputs, for explainability.
    metrics: jsonb("metrics").notNull(),
    llmQualityAdjustment: decimal("llm_quality_adjustment", {
      precision: 6,
      scale: 2,
    }),
    llmNarrative: text("llm_narrative"),
    llmEvidence: jsonb("llm_evidence"),
    llmStatus: text("llm_status"),
    llmModel: text("llm_model"),
    llmCalledAt: timestamp("llm_called_at", { withTimezone: true }),
    llmCostUsd: decimal("llm_cost_usd", { precision: 20, scale: 10 }),
    triggeredBy: text("triggered_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("github_delivery_reports_user_time_idx").on(
      t.userId,
      t.periodStart,
    ),
    orgTimeIdx: index("github_delivery_reports_org_time_idx").on(
      t.orgId,
      t.periodStart,
    ),
    orgPeriodUniq: uniqueIndex("github_delivery_reports_org_period_uniq").on(
      t.orgId,
      t.userId,
      t.periodStart,
      t.periodType,
    ),
  }),
);
```

- [ ] **Step 5: Append to barrel `packages/db/src/schema/index.ts`** (at end, order-of-introduction):

```ts
export * from "./githubConnections.js";
export * from "./githubActivity.js";
export * from "./githubDeliveryReports.js";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @caliber/db typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/
git commit -m "feat(db): github delivery schema — connections, sync state, activity, reports"
```

---

### Task 2: Migration 0032 + down + journal + migration integration test

**Files:**
- Create: `packages/db/drizzle/0032_github_delivery.sql`
- Create: `packages/db/drizzle/0032_down.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append entry)
- Test: `apps/api/tests/integration/migrations/0032.test.ts`

**Interfaces:**
- Consumes: table definitions from Task 1 (SQL must match them exactly).
- Produces: tables exist in every test DB via `setupTestDb()` (which runs all migrations); later integration tests rely on this.

- [ ] **Step 1: Write the failing migration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, migrationsFolder } from "../../factories/index.js";

const TABLES = [
  "github_connections",
  "github_sync_state",
  "github_pull_requests",
  "github_reviews",
  "github_issues",
  "github_project_items",
  "github_delivery_reports",
] as const;

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

describe("migration 0032_github_delivery", () => {
  it("creates all seven tables", async () => {
    const res = await t.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'github_%'
      ORDER BY table_name
    `);
    const names = res.rows.map((r) => r.table_name);
    for (const name of TABLES) expect(names).toContain(name);
  });

  it("enforces one connection per org and unique activity node ids", async () => {
    const uniq = await t.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('github_sync_state','github_pull_requests','github_delivery_reports')
    `);
    const idx = uniq.rows.map((r) => r.indexname);
    expect(idx).toContain("github_sync_state_org_repo_resource_uniq");
    expect(idx).toContain("github_pull_requests_org_node_uniq");
    expect(idx).toContain("github_delivery_reports_org_period_uniq");
  });

  it("down migration drops all seven tables", async () => {
    const downSql = await readFile(
      path.join(migrationsFolder, "0032_down.sql"),
      "utf8",
    );
    await t.pool.query(downSql);
    const res = await t.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'github_%'
    `);
    expect(res.rows).toHaveLength(0);
    // Re-apply for any test pollution paranoia: this file runs isolated,
    // its own container is discarded afterward, so no re-up needed.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api test:integration 0032`
Expected: FAIL — tables missing (migration doesn't exist yet).

- [ ] **Step 3: Write `0032_github_delivery.sql`**

```sql
-- 0032_github_delivery.sql
-- GitHub delivery scoring PR1 (spec 2026-07-15): org PAT connection,
-- sync watermarks, activity metadata, delivery reports.
CREATE TABLE "github_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE cascade,
  "owner_login" text NOT NULL,
  "nonce" bytea NOT NULL,
  "ciphertext" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "token_last4" text NOT NULL,
  "repo_allowlist" jsonb,
  "delivery_enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'ok',
  "last_sync_at" timestamp with time zone,
  "last_sync_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "github_sync_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "resource_type" text NOT NULL,
  "watermark" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_sync_state_org_repo_resource_uniq"
  ON "github_sync_state" ("org_id","repo_full_name","resource_type");
--> statement-breakpoint
CREATE TABLE "github_pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "number" integer NOT NULL,
  "gh_node_id" text NOT NULL,
  "author_gh_id" bigint,
  "author_login" text,
  "state" text NOT NULL,
  "draft" boolean NOT NULL DEFAULT false,
  "title" text NOT NULL,
  "html_url" text NOT NULL,
  "base_ref" text NOT NULL,
  "additions" integer NOT NULL DEFAULT 0,
  "deletions" integer NOT NULL DEFAULT 0,
  "changed_files" integer NOT NULL DEFAULT 0,
  "commit_count" integer NOT NULL DEFAULT 0,
  "review_comment_count" integer NOT NULL DEFAULT 0,
  "gh_created_at" timestamp with time zone NOT NULL,
  "merged_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_pull_requests_org_node_uniq"
  ON "github_pull_requests" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_pull_requests_org_author_idx"
  ON "github_pull_requests" ("org_id","author_gh_id");
--> statement-breakpoint
CREATE INDEX "github_pull_requests_org_merged_idx"
  ON "github_pull_requests" ("org_id","merged_at");
--> statement-breakpoint
CREATE TABLE "github_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "gh_node_id" text NOT NULL,
  "pr_gh_node_id" text NOT NULL,
  "reviewer_gh_id" bigint,
  "reviewer_login" text,
  "state" text NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_reviews_org_node_uniq"
  ON "github_reviews" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_reviews_org_reviewer_idx"
  ON "github_reviews" ("org_id","reviewer_gh_id");
--> statement-breakpoint
CREATE TABLE "github_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "number" integer NOT NULL,
  "gh_node_id" text NOT NULL,
  "author_gh_id" bigint,
  "author_login" text,
  "assignee_gh_ids" jsonb NOT NULL,
  "state" text NOT NULL,
  "state_reason" text,
  "closed_by_gh_id" bigint,
  "title" text NOT NULL,
  "html_url" text NOT NULL,
  "gh_created_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_issues_org_node_uniq"
  ON "github_issues" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_issues_org_author_idx"
  ON "github_issues" ("org_id","author_gh_id");
--> statement-breakpoint
CREATE INDEX "github_issues_org_closed_idx"
  ON "github_issues" ("org_id","closed_at");
--> statement-breakpoint
CREATE TABLE "github_project_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "project_node_id" text NOT NULL,
  "project_title" text NOT NULL,
  "item_node_id" text NOT NULL,
  "content_type" text NOT NULL,
  "content_gh_node_id" text,
  "assignee_gh_ids" jsonb NOT NULL,
  "status_value" text,
  "is_done" boolean NOT NULL DEFAULT false,
  "gh_updated_at" timestamp with time zone NOT NULL,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_project_items_org_item_uniq"
  ON "github_project_items" ("org_id","item_node_id");
--> statement-breakpoint
CREATE INDEX "github_project_items_org_done_idx"
  ON "github_project_items" ("org_id","is_done");
--> statement-breakpoint
CREATE TABLE "github_delivery_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "period_type" text NOT NULL,
  "total_score" numeric(10,4),
  "insufficient_data" boolean NOT NULL DEFAULT false,
  "section_scores" jsonb NOT NULL,
  "metrics" jsonb NOT NULL,
  "llm_quality_adjustment" numeric(6,2),
  "llm_narrative" text,
  "llm_evidence" jsonb,
  "llm_status" text,
  "llm_model" text,
  "llm_called_at" timestamp with time zone,
  "llm_cost_usd" numeric(20,10),
  "triggered_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "github_delivery_reports_user_time_idx"
  ON "github_delivery_reports" ("user_id","period_start");
--> statement-breakpoint
CREATE INDEX "github_delivery_reports_org_time_idx"
  ON "github_delivery_reports" ("org_id","period_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "github_delivery_reports_org_period_uniq"
  ON "github_delivery_reports" ("org_id","user_id","period_start","period_type");
```

- [ ] **Step 4: Write `0032_down.sql`**

```sql
-- 0032_down.sql — reverse of 0032_github_delivery.sql
DROP TABLE IF EXISTS "github_delivery_reports";
DROP TABLE IF EXISTS "github_project_items";
DROP TABLE IF EXISTS "github_issues";
DROP TABLE IF EXISTS "github_reviews";
DROP TABLE IF EXISTS "github_pull_requests";
DROP TABLE IF EXISTS "github_sync_state";
DROP TABLE IF EXISTS "github_connections";
```

- [ ] **Step 5: Append journal entry** to `packages/db/drizzle/meta/_journal.json` `entries` array (after the `idx: 31` entry):

```json
{
  "idx": 32,
  "version": "7",
  "when": 1783699000003,
  "tag": "0032_github_delivery",
  "breakpoints": true
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @caliber/api test:integration 0032`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/ apps/api/tests/integration/migrations/0032.test.ts
git commit -m "feat(db): migration 0032 — github delivery tables (+down, journal, test)"
```

---

### Task 3: `ENABLE_GITHUB_DELIVERY` env flag

**Files:**
- Modify: `packages/config/src/env.ts` (one line, next to `ENABLE_FACET_EXTRACTION` at ~line 70)
- Modify: `docker/.env.example` (one line in the feature-flags block)

**Interfaces:**
- Produces: `env.ENABLE_GITHUB_DELIVERY: boolean` on `ServerEnv` — consumed by gateway `server.ts` (Task 13), API `_githubGate.ts` and queue injection (Task 14), and `defaultTestEnv` overrides in tests.

- [ ] **Step 1: Add the schema line** in `packages/config/src/env.ts`, directly below `ENABLE_FACET_EXTRACTION: booleanUnion.default(false),`:

```ts
    ENABLE_GITHUB_DELIVERY: booleanUnion.default(false),
```

- [ ] **Step 2: Add to `docker/.env.example`** below the `ENABLE_FACET_EXTRACTION` line (keep the surrounding comment style):

```
ENABLE_GITHUB_DELIVERY=false
```

- [ ] **Step 3: Typecheck the dependents**

Run: `pnpm --filter @caliber/config typecheck && pnpm --filter @caliber/api typecheck && pnpm --filter @caliber/gateway typecheck`
Expected: exit 0 (flag is additive with a default; nothing else changes).

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/env.ts docker/.env.example
git commit -m "feat(config): ENABLE_GITHUB_DELIVERY flag (default false, dark launch)"
```

---

### Task 4: RBAC action `github.manage`

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts` (union member, after the `evaluator.view_cost` entry at ~line 110)
- Modify: `packages/auth/src/rbac/check.ts` (case, after the `evaluator.view_cost` case at ~line 270)
- Test: `packages/auth/tests/rbac/githubManage.test.ts`

**Interfaces:**
- Produces: `can(perm, { type: "github.manage", orgId })` → true only for `org_admin` at that org. Consumed by the Task 14 router.

- [ ] **Step 1: Write the failing test** — reuse the `makePerm` helper idiom from `packages/auth/tests/rbac/byokOwnership.test.ts` (copy its `makePerm` function verbatim into this file; it builds a `UserPermissions` from role rows):

```ts
import { describe, it, expect } from "vitest";
import { can } from "../../src/rbac/check.js";
// Copy the makePerm() helper verbatim from ./byokOwnership.test.ts
// (builds UserPermissions from {role, scopeType, scopeId} rows).

describe("github.manage", () => {
  it("allows org_admin of the same org", () => {
    const perm = makePerm([
      { role: "org_admin", scopeType: "organization", scopeId: "org-1" },
    ]);
    expect(can(perm, { type: "github.manage", orgId: "org-1" })).toBe(true);
  });

  it("denies org_admin of a different org", () => {
    const perm = makePerm([
      { role: "org_admin", scopeType: "organization", scopeId: "org-2" },
    ]);
    expect(can(perm, { type: "github.manage", orgId: "org-1" })).toBe(false);
  });

  it("denies a plain member", () => {
    const perm = makePerm([
      { role: "member", scopeType: "organization", scopeId: "org-1" },
    ]);
    expect(can(perm, { type: "github.manage", orgId: "org-1" })).toBe(false);
  });
});
```

(If the `Role` union does not include `"member"`, use whatever non-admin role `byokOwnership.test.ts` uses for its negative cases.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/auth test githubManage`
Expected: FAIL — TS error / unknown action type `github.manage`.

- [ ] **Step 3: Add the union member** in `actions.ts` (after `evaluator.view_cost`):

```ts
  | { type: "github.manage"; orgId: string }
```

- [ ] **Step 4: Add the case** in `check.ts` (after the `evaluator.view_cost` case):

```ts
    case "github.manage":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/auth test githubManage`
Expected: PASS (3 tests). Also run `pnpm --filter @caliber/auth typecheck` — the exhaustive switch must still compile.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/rbac/ packages/auth/tests/rbac/githubManage.test.ts
git commit -m "feat(auth): github.manage RBAC action (org_admin only)"
```

---

### Task 5: GitHub token redaction patterns

**Files:**
- Modify: `packages/gateway-core/src/logging/redact.ts` (two entries in `CREDENTIAL_PATTERNS`, ~line 82)
- Test: `packages/gateway-core/tests/logging/redact.test.ts` (append cases)

**Interfaces:**
- Produces: `maskCredentialMaterial` / `safeErrorMessage` now scrub GitHub tokens. Task 12's `syncOrg` relies on `safeErrorMessage` for every stored error string.

- [ ] **Step 1: Write the failing tests** — append to the existing describe block in `redact.test.ts`, matching its existing style:

```ts
  it("masks fine-grained GitHub PATs", () => {
    const input =
      "boom github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP failed";
    const out = maskCredentialMaterial(input);
    expect(out).not.toContain("github_pat_11ABCDEFG");
    expect(out).toContain("[REDACTED-GITHUB-PAT]");
  });

  it("masks classic ghp_/gho_ style GitHub tokens", () => {
    const out = maskCredentialMaterial(
      "auth ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 rejected",
    );
    expect(out).not.toContain("ghp_AbCdEfGh");
    expect(out).toContain("[REDACTED-GITHUB-TOKEN]");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/gateway-core test redact`
Expected: FAIL — output still contains the raw tokens.

- [ ] **Step 3: Add the patterns** to `CREDENTIAL_PATTERNS`, BEFORE the generic `Bearer` entry (specific before generic, matching the array's documented ordering):

```ts
  // GitHub fine-grained PAT (github_pat_<22 chars>_<59 chars>)
  { regex: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED-GITHUB-PAT]" },
  // GitHub classic/app tokens: ghp_ gho_ ghu_ ghs_ ghr_
  { regex: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED-GITHUB-TOKEN]" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/gateway-core test redact`
Expected: PASS (existing cases + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/src/logging/redact.ts packages/gateway-core/tests/logging/redact.test.ts
git commit -m "feat(gateway-core): redact GitHub PAT/token shapes in credential masking"
```

---

### Task 6: `github-sync` queue module

**Files:**
- Create: `apps/gateway/src/workers/githubSync/queue.ts`
- Test: `apps/gateway/tests/workers/githubSyncQueue.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (bullmq, zod, ioredis types).
- Produces (used by Tasks 13-14):
  - `GITHUB_SYNC_QUEUE_NAME = "github-sync"`, `GITHUB_SYNC_QUEUE_PREFIX = "caliber:gw"`, `GITHUB_SYNC_JOB_NAME = "github-sync"`
  - `GithubSyncJobPayload` (zod) / `type GithubSyncJobPayload = { orgId: string; triggeredBy: "interval" | "manual" }`
  - `buildGithubSyncJobId({ orgId }): string`
  - `interface QueueLike { add(name, data, opts?): Promise<unknown>; close?(): Promise<void> }`
  - `createGithubSyncQueue({ connection, prefix?, defaultJobOptions? }): Queue<GithubSyncJobPayload>`
  - `enqueueGithubSync(queue: QueueLike, payload: unknown): Promise<{ jobId: string }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_SYNC_JOB_NAME,
  GithubSyncJobPayload,
  buildGithubSyncJobId,
  enqueueGithubSync,
  type QueueLike,
} from "../../src/workers/githubSync/queue.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";

describe("buildGithubSyncJobId", () => {
  it("is deterministic and contains no colons", () => {
    const id = buildGithubSyncJobId({ orgId: ORG });
    expect(id).toBe(buildGithubSyncJobId({ orgId: ORG }));
    expect(id).not.toContain(":");
    expect(id).toContain(ORG);
  });
});

describe("enqueueGithubSync", () => {
  it("validates payload and adds with the deterministic jobId", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue: QueueLike = { add };
    const { jobId } = await enqueueGithubSync(queue, {
      orgId: ORG,
      triggeredBy: "manual",
    });
    expect(add).toHaveBeenCalledWith(
      GITHUB_SYNC_JOB_NAME,
      { orgId: ORG, triggeredBy: "manual" },
      { jobId },
    );
  });

  it("rejects an invalid payload", async () => {
    const queue: QueueLike = { add: vi.fn() };
    await expect(
      enqueueGithubSync(queue, { orgId: "not-a-uuid", triggeredBy: "manual" }),
    ).rejects.toThrow();
  });

  it("zod schema rejects unknown triggeredBy", () => {
    expect(
      GithubSyncJobPayload.safeParse({ orgId: ORG, triggeredBy: "cron" })
        .success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test githubSyncQueue`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `queue.ts`**

```ts
/**
 * github-sync queue (PR1, spec 2026-07-15). Mirrors
 * apps/gateway/src/workers/evaluator/queue.ts. One job per org;
 * deterministic jobId dedups repeat triggers (interval + manual).
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import type { Redis, RedisOptions } from "ioredis";

export const GITHUB_SYNC_QUEUE_NAME = "github-sync";
export const GITHUB_SYNC_QUEUE_PREFIX = "caliber:gw";
export const GITHUB_SYNC_JOB_NAME = "github-sync";

export const GITHUB_SYNC_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

export const GithubSyncJobPayload = z.object({
  orgId: z.string().uuid(),
  triggeredBy: z.enum(["interval", "manual"]),
});
export type GithubSyncJobPayload = z.infer<typeof GithubSyncJobPayload>;

/** BullMQ rejects custom ids containing ':' — keep this colon-free. */
export function buildGithubSyncJobId(input: { orgId: string }): string {
  return ["ghsync", "v1", input.orgId].join("_").replaceAll(":", "-");
}

/** DI seam so tests and the API server can pass fakes (no Redis). */
export interface QueueLike {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
  close?(): Promise<void>;
}

export interface CreateGithubSyncQueueOptions {
  connection: Redis | RedisOptions;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createGithubSyncQueue(
  opts: CreateGithubSyncQueueOptions,
): Queue<GithubSyncJobPayload> {
  return new Queue<GithubSyncJobPayload>(GITHUB_SYNC_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? GITHUB_SYNC_QUEUE_PREFIX,
    defaultJobOptions: {
      ...GITHUB_SYNC_DEFAULT_JOB_OPTIONS,
      backoff: { ...GITHUB_SYNC_DEFAULT_JOB_OPTIONS.backoff },
      ...opts.defaultJobOptions,
    },
  });
}

export async function enqueueGithubSync(
  queue: QueueLike,
  payload: unknown,
): Promise<{ jobId: string }> {
  const validated = GithubSyncJobPayload.parse(payload);
  const jobId = buildGithubSyncJobId(validated);
  await queue.add(GITHUB_SYNC_JOB_NAME, validated, { jobId });
  return { jobId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test githubSyncQueue`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/queue.ts apps/gateway/tests/workers/githubSyncQueue.test.ts
git commit -m "feat(gateway): github-sync queue module (payload schema, colon-free jobId)"
```

---

### Task 7: GitHub API client (fetch-based, DI, no octokit)

**Files:**
- Create: `apps/gateway/src/workers/githubSync/githubClient.ts`
- Test: `apps/gateway/tests/workers/githubSync/githubClient.test.ts`

**Interfaces:**
- Consumes: nothing project-specific. `fetchImpl` DI follows the `facetLlmClient.ts` idiom.
- Produces (used by Tasks 9-12):
  - `createGithubClient({ token, fetchImpl?, baseUrl? }): GithubClient`
  - `interface GithubClient` with `listRepoFullNames(owner)`, `listPullsSince(repoFullName, sinceIso | null)`, `getPull(repoFullName, number)`, `listReviews(repoFullName, number)`, `listIssuesSince(repoFullName, sinceIso | null)`, `getIssue(repoFullName, number)`, `graphql<T>(query, variables)`
  - API shape interfaces: `GithubApiUser`, `GithubApiPullListItem`, `GithubApiPullDetail`, `GithubApiReview`, `GithubApiIssue`
  - Errors: `GithubAuthError`, `GithubRateLimitError` (with `resetAtMs: number | null`), `GithubHttpError` (with `status: number`)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  createGithubClient,
  GithubAuthError,
  GithubRateLimitError,
} from "../../../src/workers/githubSync/githubClient.js";

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** fetchImpl returning queued responses in order. */
function fetchQueue(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

const client = (fetchImpl: unknown) =>
  createGithubClient({
    token: "github_pat_TESTTOKEN00000000000000",
    fetchImpl: fetchImpl as typeof fetch,
  });

describe("createGithubClient", () => {
  it("sends Bearer auth + API version headers", async () => {
    const fetchImpl = fetchQueue(jsonRes([]));
    await client(fetchImpl).listRepoFullNames("acme");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/orgs/acme/repos");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(
      "Bearer github_pat_TESTTOKEN00000000000000",
    );
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("listPullsSince stops paging at the since cutoff", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: 200 - i,
      node_id: `PR_${200 - i}`,
      updated_at: "2026-07-10T00:00:00Z",
    }));
    // second page is older than `since` — must be cut off, no page 3 fetched
    const page2 = Array.from({ length: 100 }, (_, i) => ({
      number: 100 - i,
      node_id: `PR_${100 - i}`,
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const fetchImpl = fetchQueue(jsonRes(page1), jsonRes(page2));
    const items = await client(fetchImpl).listPullsSince(
      "acme/web",
      "2026-07-01T00:00:00Z",
    );
    expect(items).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("listIssuesSince filters out pull requests", async () => {
    const fetchImpl = fetchQueue(
      jsonRes([
        { number: 1, node_id: "I_1", updated_at: "2026-07-10T00:00:00Z" },
        {
          number: 2,
          node_id: "PR_2",
          updated_at: "2026-07-10T00:00:00Z",
          pull_request: { url: "x" },
        },
      ]),
    );
    const items = await client(fetchImpl).listIssuesSince("acme/web", null);
    expect(items.map((i) => i.node_id)).toEqual(["I_1"]);
  });

  it("maps 401 to GithubAuthError", async () => {
    const fetchImpl = fetchQueue(jsonRes({ message: "Bad credentials" }, 401));
    await expect(client(fetchImpl).getPull("acme/web", 1)).rejects.toBeInstanceOf(
      GithubAuthError,
    );
  });

  it("maps 403 + x-ratelimit-remaining:0 to GithubRateLimitError with reset", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "rate limited" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1783700000",
      }),
    );
    const err = await client(fetchImpl)
      .getPull("acme/web", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect((err as GithubRateLimitError).resetAtMs).toBe(1783700000 * 1000);
  });

  it("graphql surfaces GraphQL errors and returns data otherwise", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ data: { organization: { projectsV2: { nodes: [] } } } }),
    );
    const data = await client(fetchImpl).graphql<{ organization: unknown }>(
      "query { viewer { login } }",
      {},
    );
    expect(data.organization).toBeDefined();

    const bad = fetchQueue(jsonRes({ errors: [{ message: "nope" }] }));
    await expect(client(bad).graphql("query {}", {})).rejects.toThrow("nope");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/gateway test githubClient`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `githubClient.ts`**

```ts
/**
 * Minimal GitHub REST + GraphQL client (PR1, spec 2026-07-15).
 * fetch-based with fetchImpl DI (repo idiom: facetLlmClient.ts) — no octokit.
 * Error taxonomy lets syncOrg distinguish auth / rate-limit / other so the
 * connection status lands as 'auth_error' | 'rate_limited' | 'sync_error'.
 * Error messages never include the token (they carry path + status only).
 */

export interface GithubApiUser {
  id: number;
  login: string;
}

export interface GithubApiPullListItem {
  number: number;
  node_id: string;
  updated_at: string;
}

export interface GithubApiPullDetail {
  number: number;
  node_id: string;
  state: "open" | "closed";
  draft?: boolean;
  title: string;
  html_url: string;
  user: GithubApiUser | null;
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  review_comments: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

export interface GithubApiReview {
  node_id: string;
  user: GithubApiUser | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at: string | null;
}

export interface GithubApiIssue {
  number: number;
  node_id: string;
  state: "open" | "closed";
  state_reason?: string | null;
  title: string;
  html_url: string;
  user: GithubApiUser | null;
  assignees?: GithubApiUser[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by?: GithubApiUser | null;
  pull_request?: unknown;
}

export class GithubAuthError extends Error {}

export class GithubRateLimitError extends Error {
  constructor(public readonly resetAtMs: number | null) {
    super("github rate limited");
  }
}

export class GithubHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GithubClient {
  listRepoFullNames(owner: string): Promise<string[]>;
  listPullsSince(
    repoFullName: string,
    sinceIso: string | null,
  ): Promise<GithubApiPullListItem[]>;
  getPull(repoFullName: string, number: number): Promise<GithubApiPullDetail>;
  listReviews(
    repoFullName: string,
    number: number,
  ): Promise<GithubApiReview[]>;
  listIssuesSince(
    repoFullName: string,
    sinceIso: string | null,
  ): Promise<GithubApiIssue[]>;
  getIssue(repoFullName: string, number: number): Promise<GithubApiIssue>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GithubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const PER_PAGE = 100;
// Safety cap: 50 pages × 100 = 5000 rows per resource per repo per sync.
const MAX_PAGES = 50;

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");

  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "caliber-gateway",
  };

  async function request(
    path: string,
    searchParams?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetchFn(url.toString(), { method: "GET", headers });
    return handleResponse(res, path);
  }

  async function handleResponse(res: Response, path: string): Promise<unknown> {
    if (res.status === 401) {
      throw new GithubAuthError(`github token rejected (401) for ${path}`);
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      if (remaining === "0" || retryAfter !== null) {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetAtMs = reset
          ? Number(reset) * 1000
          : retryAfter
            ? Date.now() + Number(retryAfter) * 1000
            : null;
        throw new GithubRateLimitError(resetAtMs);
      }
      // 403 without rate-limit markers = PAT lacks permission for the resource.
      throw new GithubAuthError(`github access denied (403) for ${path}`);
    }
    if (!res.ok) {
      throw new GithubHttpError(res.status, `github api ${res.status} for ${path}`);
    }
    return res.json();
  }

  async function* pages(
    path: string,
    extraParams: Record<string, string>,
  ): AsyncGenerator<unknown[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const chunk = (await request(path, {
        ...extraParams,
        per_page: String(PER_PAGE),
        page: String(page),
      })) as unknown[];
      if (chunk.length === 0) return;
      yield chunk;
      if (chunk.length < PER_PAGE) return;
    }
  }

  return {
    async listRepoFullNames(owner) {
      const out: string[] = [];
      for await (const chunk of pages(`/orgs/${owner}/repos`, {})) {
        for (const repo of chunk as Array<{ full_name: string }>) {
          out.push(repo.full_name);
        }
      }
      return out;
    },

    async listPullsSince(repoFullName, sinceIso) {
      const out: GithubApiPullListItem[] = [];
      for await (const chunk of pages(`/repos/${repoFullName}/pulls`, {
        state: "all",
        sort: "updated",
        direction: "desc",
      })) {
        for (const item of chunk as GithubApiPullListItem[]) {
          if (sinceIso !== null && item.updated_at < sinceIso) return out;
          out.push(item);
        }
      }
      return out;
    },

    async getPull(repoFullName, number) {
      return (await request(
        `/repos/${repoFullName}/pulls/${number}`,
      )) as GithubApiPullDetail;
    },

    async listReviews(repoFullName, number) {
      const out: GithubApiReview[] = [];
      for await (const chunk of pages(
        `/repos/${repoFullName}/pulls/${number}/reviews`,
        {},
      )) {
        out.push(...(chunk as GithubApiReview[]));
      }
      return out;
    },

    async listIssuesSince(repoFullName, sinceIso) {
      const params: Record<string, string> = {
        state: "all",
        sort: "updated",
        direction: "desc",
      };
      if (sinceIso !== null) params.since = sinceIso;
      const out: GithubApiIssue[] = [];
      for await (const chunk of pages(`/repos/${repoFullName}/issues`, params)) {
        for (const item of chunk as GithubApiIssue[]) {
          if (item.pull_request === undefined) out.push(item);
        }
      }
      return out;
    },

    async getIssue(repoFullName, number) {
      return (await request(
        `/repos/${repoFullName}/issues/${number}`,
      )) as GithubApiIssue;
    },

    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const res = await fetchFn(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await handleResponse(res, "/graphql")) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };
      if (body.errors && body.errors.length > 0) {
        throw new GithubHttpError(
          200,
          `github graphql: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }
      if (body.data === undefined) {
        throw new GithubHttpError(200, "github graphql: empty data");
      }
      return body.data;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/gateway test githubClient`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/githubClient.ts apps/gateway/tests/workers/githubSync/githubClient.test.ts
git commit -m "feat(gateway): fetch-based GitHub REST+GraphQL client with auth/rate-limit taxonomy"
```

---

### Task 8: Row mappers (pure functions)

**Files:**
- Create: `apps/gateway/src/workers/githubSync/mappers.ts`
- Test: `apps/gateway/tests/workers/githubSync/mappers.test.ts`

**Interfaces:**
- Consumes: API shapes from Task 7; `$inferInsert` types via `@caliber/db` tables from Task 1.
- Produces (used by Tasks 9-11):
  - `mapPullRow({ orgId, repoFullName, pull }): NewGithubPullRequest`
  - `mapReviewRows({ orgId, repoFullName, prGhNodeId, reviews }): NewGithubReview[]` — drops PENDING / null `submitted_at`
  - `mapIssueRow({ orgId, repoFullName, issue }): NewGithubIssue`
  - `mapProjectItemRow({ orgId, node }): NewGithubProjectItem` + `interface GithubProjectItemNode` (normalized GraphQL node, produced by Task 11)
  - `DONE_STATUS_REGEX`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  mapPullRow,
  mapReviewRows,
  mapIssueRow,
  mapProjectItemRow,
  DONE_STATUS_REGEX,
} from "../../../src/workers/githubSync/mappers.js";
import type { GithubApiPullDetail } from "../../../src/workers/githubSync/githubClient.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";

function makePull(overrides: Partial<GithubApiPullDetail> = {}): GithubApiPullDetail {
  return {
    number: 42,
    node_id: "PR_kw42",
    state: "closed",
    draft: false,
    title: "fix: thing",
    html_url: "https://github.com/acme/web/pull/42",
    user: { id: 777, login: "hanfour" },
    base: { ref: "main" },
    additions: 10,
    deletions: 3,
    changed_files: 2,
    commits: 1,
    review_comments: 4,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    merged_at: "2026-07-02T10:00:00Z",
    closed_at: "2026-07-02T10:00:00Z",
    ...overrides,
  };
}

describe("mapPullRow", () => {
  it("maps a merged PR with author ids", () => {
    const row = mapPullRow({ orgId: ORG, repoFullName: "acme/web", pull: makePull() });
    expect(row).toMatchObject({
      orgId: ORG,
      repoFullName: "acme/web",
      number: 42,
      ghNodeId: "PR_kw42",
      authorGhId: 777,
      authorLogin: "hanfour",
      state: "closed",
      draft: false,
      baseRef: "main",
      additions: 10,
      reviewCommentCount: 4,
    });
    expect(row.mergedAt).toEqual(new Date("2026-07-02T10:00:00Z"));
  });

  it("handles deleted (ghost) authors and open PRs", () => {
    const row = mapPullRow({
      orgId: ORG,
      repoFullName: "acme/web",
      pull: makePull({ user: null, state: "open", merged_at: null, closed_at: null }),
    });
    expect(row.authorGhId).toBeNull();
    expect(row.authorLogin).toBeNull();
    expect(row.mergedAt).toBeNull();
    expect(row.closedAt).toBeNull();
  });
});

describe("mapReviewRows", () => {
  it("drops PENDING and null-submitted reviews", () => {
    const rows = mapReviewRows({
      orgId: ORG,
      repoFullName: "acme/web",
      prGhNodeId: "PR_kw42",
      reviews: [
        { node_id: "R_1", user: { id: 5, login: "joe" }, state: "APPROVED", submitted_at: "2026-07-02T09:00:00Z" },
        { node_id: "R_2", user: { id: 5, login: "joe" }, state: "PENDING", submitted_at: null },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ghNodeId: "R_1",
      prGhNodeId: "PR_kw42",
      reviewerGhId: 5,
      state: "APPROVED",
    });
  });
});

describe("mapIssueRow", () => {
  it("maps assignees and closed_by to numeric ids", () => {
    const row = mapIssueRow({
      orgId: ORG,
      repoFullName: "acme/web",
      issue: {
        number: 7,
        node_id: "I_7",
        state: "closed",
        state_reason: "completed",
        title: "bug",
        html_url: "https://github.com/acme/web/issues/7",
        user: { id: 1, login: "a" },
        assignees: [{ id: 2, login: "b" }, { id: 3, login: "c" }],
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-03T00:00:00Z",
        closed_at: "2026-07-03T00:00:00Z",
        closed_by: { id: 2, login: "b" },
      },
    });
    expect(row.assigneeGhIds).toEqual([2, 3]);
    expect(row.closedByGhId).toBe(2);
    expect(row.stateReason).toBe("completed");
  });
});

describe("mapProjectItemRow / DONE_STATUS_REGEX", () => {
  it("marks Done-ish statuses as done", () => {
    for (const s of ["Done", "done", "Completed", "Shipped", "closed"]) {
      expect(DONE_STATUS_REGEX.test(s)).toBe(true);
    }
    for (const s of ["In Progress", "Todo", "Blocked", "Done-ish"]) {
      expect(DONE_STATUS_REGEX.test(s)).toBe(false);
    }
    const row = mapProjectItemRow({
      orgId: ORG,
      node: {
        itemNodeId: "PVTI_1",
        projectNodeId: "PVT_1",
        projectTitle: "Q3 Roadmap",
        contentType: "ISSUE",
        contentGhNodeId: "I_7",
        assigneeGhIds: [2],
        statusValue: "Done",
        ghUpdatedAt: "2026-07-03T00:00:00Z",
      },
    });
    expect(row.isDone).toBe(true);
    expect(row.ghUpdatedAt).toEqual(new Date("2026-07-03T00:00:00Z"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/gateway test workers/githubSync/mappers`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `mappers.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/gateway test workers/githubSync/mappers`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/mappers.ts apps/gateway/tests/workers/githubSync/mappers.test.ts
git commit -m "feat(gateway): pure GitHub API-to-row mappers for sync upserts"
```

---

### Task 9: Watermarks + PR/review sync

**Files:**
- Create: `apps/gateway/src/workers/githubSync/watermarks.ts`
- Create: `apps/gateway/src/workers/githubSync/syncPulls.ts`
- Test: `apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts`

**Interfaces:**
- Consumes: `GithubClient` (Task 7 — integration tests stub this INTERFACE directly, no fetch involved), mappers (Task 8), tables (Task 1).
- Produces:
  - `getWatermark(db, orgId, repoFullName, resourceType): Promise<Date | null>`
  - `setWatermark(db, { orgId, repoFullName, resourceType, watermark }): Promise<void>`
  - `syncRepoPulls({ db, client, orgId, repoFullName }): Promise<{ pulls: number; reviews: number }>`

- [ ] **Step 1: Write the failing integration test**

Testcontainer boilerplate: copy the `beforeAll` container + `migrate` block from `apps/gateway/tests/workers/evaluator/workerRubricWiring.integration.test.ts:25-45` (PostgreSqlContainer only — no Redis needed here). Also copy its org-insert statement for the `insertOrg` helper below (if `organizations` requires more columns than `name`, mirror that file exactly).

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// … container/migrate imports copied from workerRubricWiring.integration.test.ts …
import { organizations, githubPullRequests, githubReviews } from "@caliber/db";
import {
  getWatermark,
  setWatermark,
} from "../../../src/workers/githubSync/watermarks.js";
import { syncRepoPulls } from "../../../src/workers/githubSync/syncPulls.js";
import type {
  GithubClient,
  GithubApiPullDetail,
} from "../../../src/workers/githubSync/githubClient.js";

const REPO = "acme/web";

function makeDetail(n: number, updatedAt: string, state: "open" | "closed" = "open"): GithubApiPullDetail {
  return {
    number: n, node_id: `PR_${n}`, state, draft: false, title: `pr ${n}`,
    html_url: `https://github.com/${REPO}/pull/${n}`,
    user: { id: 777, login: "hanfour" }, base: { ref: "main" },
    additions: 1, deletions: 1, changed_files: 1, commits: 1, review_comments: 0,
    created_at: "2026-07-01T00:00:00Z", updated_at: updatedAt,
    merged_at: state === "closed" ? updatedAt : null,
    closed_at: state === "closed" ? updatedAt : null,
  };
}

/** GithubClient stub: only the methods syncRepoPulls touches. */
function stubClient(details: GithubApiPullDetail[], calls: string[][] = []): GithubClient {
  return {
    listRepoFullNames: async () => [REPO],
    listPullsSince: async (_repo, since) => {
      calls.push(["listPullsSince", String(since)]);
      return details
        .filter((d) => since === null || d.updated_at >= since)
        .map((d) => ({ number: d.number, node_id: d.node_id, updated_at: d.updated_at }));
    },
    getPull: async (_repo, n) => details.find((d) => d.number === n)!,
    listReviews: async (_repo, n) =>
      n === 1
        ? [{ node_id: "R_1", user: { id: 5, login: "joe" }, state: "APPROVED", submitted_at: "2026-07-02T00:00:00Z" }]
        : [],
    listIssuesSince: async () => [],
    getIssue: async () => { throw new Error("unused"); },
    graphql: async () => { throw new Error("unused"); },
  };
}

describe("syncRepoPulls", () => {
  // beforeAll: start container, migrate, create db handle; insertOrg helper.

  it("first sync inserts PRs + reviews and sets the pulls watermark", async () => {
    const org = await insertOrg(db);
    const client = stubClient([makeDetail(1, "2026-07-02T00:00:00Z", "closed"), makeDetail(2, "2026-07-03T00:00:00Z")]);
    const res = await syncRepoPulls({ db, client, orgId: org.id, repoFullName: REPO });
    expect(res).toEqual({ pulls: 2, reviews: 1 });
    const prs = await db.select().from(githubPullRequests);
    expect(prs.filter((p) => p.orgId === org.id)).toHaveLength(2);
    const wm = await getWatermark(db, org.id, REPO, "pulls");
    expect(wm).toEqual(new Date("2026-07-03T00:00:00Z"));
  });

  it("second sync passes the watermark and upserts without duplicating", async () => {
    const org = await insertOrg(db);
    const calls: string[][] = [];
    const d1 = makeDetail(1, "2026-07-02T00:00:00Z");
    await syncRepoPulls({ db, client: stubClient([d1], calls), orgId: org.id, repoFullName: REPO });
    // PR 1 got merged later — same node_id, newer updated_at
    const d1v2 = makeDetail(1, "2026-07-05T00:00:00Z", "closed");
    await syncRepoPulls({ db, client: stubClient([d1v2], calls), orgId: org.id, repoFullName: REPO });

    expect(calls[1][1]).toBe("2026-07-02T00:00:00.000Z"); // watermark forwarded
    const prs = (await db.select().from(githubPullRequests)).filter((p) => p.orgId === org.id);
    expect(prs).toHaveLength(1); // upserted, not duplicated
    expect(prs[0].state).toBe("closed");
    expect(prs[0].mergedAt).toEqual(new Date("2026-07-05T00:00:00Z"));
  });

  it("setWatermark upserts on conflict", async () => {
    const org = await insertOrg(db);
    await setWatermark(db, { orgId: org.id, repoFullName: REPO, resourceType: "pulls", watermark: new Date("2026-01-01T00:00:00Z") });
    await setWatermark(db, { orgId: org.id, repoFullName: REPO, resourceType: "pulls", watermark: new Date("2026-02-01T00:00:00Z") });
    expect(await getWatermark(db, org.id, REPO, "pulls")).toEqual(new Date("2026-02-01T00:00:00Z"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration syncPulls`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `watermarks.ts`**

```ts
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
```

- [ ] **Step 4: Write `syncPulls.ts`**

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration syncPulls`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/workers/githubSync/watermarks.ts apps/gateway/src/workers/githubSync/syncPulls.ts apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts
git commit -m "feat(gateway): incremental PR/review sync with per-repo watermarks"
```

---

### Task 10: Issue sync

**Files:**
- Create: `apps/gateway/src/workers/githubSync/syncIssues.ts`
- Test: `apps/gateway/tests/workers/githubSync/syncIssues.integration.test.ts`

**Interfaces:**
- Consumes: `GithubClient`, `mapIssueRow`, watermarks, `githubIssues` table.
- Produces: `syncRepoIssues({ db, client, orgId, repoFullName }): Promise<{ issues: number }>`

- [ ] **Step 1: Write the failing integration test** (same container boilerplate as Task 9; stub client implements only `listIssuesSince` + `getIssue`, other methods throw):

```ts
// … same beforeAll/insertOrg boilerplate as syncPulls.integration.test.ts …
import { githubIssues } from "@caliber/db";
import { syncRepoIssues } from "../../../src/workers/githubSync/syncIssues.js";
import { getWatermark } from "../../../src/workers/githubSync/watermarks.js";
import type { GithubApiIssue } from "../../../src/workers/githubSync/githubClient.js";

const openIssue: GithubApiIssue = {
  number: 1, node_id: "I_1", state: "open", state_reason: null, title: "a",
  html_url: "https://github.com/acme/web/issues/1",
  user: { id: 1, login: "a" }, assignees: [],
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-02T00:00:00Z", closed_at: null,
};
// List payloads omit closed_by — the sync must fetch the detail for closed issues.
const closedListItem: GithubApiIssue = {
  number: 2, node_id: "I_2", state: "closed", state_reason: "completed", title: "b",
  html_url: "https://github.com/acme/web/issues/2",
  user: { id: 1, login: "a" }, assignees: [{ id: 2, login: "b" }],
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-03T00:00:00Z",
  closed_at: "2026-07-03T00:00:00Z",
};

it("inserts issues, fetching detail (closed_by) only for closed ones", async () => {
  const org = await insertOrg(db);
  const getIssueCalls: number[] = [];
  const client = {
    ...throwingClientStub(), // all methods throw
    listIssuesSince: async () => [openIssue, closedListItem],
    getIssue: async (_repo: string, n: number) => {
      getIssueCalls.push(n);
      return { ...closedListItem, closed_by: { id: 2, login: "b" } };
    },
  };
  const res = await syncRepoIssues({ db, client, orgId: org.id, repoFullName: "acme/web" });
  expect(res).toEqual({ issues: 2 });
  expect(getIssueCalls).toEqual([2]); // only the closed issue

  const rows = (await db.select().from(githubIssues)).filter((r) => r.orgId === org.id);
  const closed = rows.find((r) => r.ghNodeId === "I_2");
  expect(closed?.closedByGhId).toBe(2);
  expect(closed?.assigneeGhIds).toEqual([2]);
  expect(await getWatermark(db, org.id, "acme/web", "issues")).toEqual(
    new Date("2026-07-03T00:00:00Z"),
  );
});

it("re-sync upserts state changes without duplicating", async () => {
  const org = await insertOrg(db);
  const base = { ...openIssue };
  const client1 = { ...throwingClientStub(), listIssuesSince: async () => [base], getIssue: async () => base };
  await syncRepoIssues({ db, client: client1, orgId: org.id, repoFullName: "acme/web" });
  const closedNow = { ...base, state: "closed" as const, state_reason: "completed", closed_at: "2026-07-05T00:00:00Z", updated_at: "2026-07-05T00:00:00Z" };
  const client2 = { ...throwingClientStub(), listIssuesSince: async () => [closedNow], getIssue: async () => ({ ...closedNow, closed_by: { id: 9, login: "z" } }) };
  await syncRepoIssues({ db, client: client2, orgId: org.id, repoFullName: "acme/web" });

  const rows = (await db.select().from(githubIssues)).filter((r) => r.orgId === org.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("closed");
  expect(rows[0].closedByGhId).toBe(9);
});
```

(`throwingClientStub()` is a tiny local helper returning a `GithubClient` whose every method rejects with `new Error("unused")` — define it once at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration syncIssues`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `syncIssues.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration syncIssues`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/syncIssues.ts apps/gateway/tests/workers/githubSync/syncIssues.integration.test.ts
git commit -m "feat(gateway): incremental issue sync with closed_by detail fetch"
```

---

### Task 11: Projects v2 sync (GraphQL)

**Files:**
- Create: `apps/gateway/src/workers/githubSync/syncProjects.ts`
- Test: `apps/gateway/tests/workers/githubSync/syncProjects.integration.test.ts`

**Interfaces:**
- Consumes: `GithubClient.graphql`, `mapProjectItemRow` + `GithubProjectItemNode` (Task 8), `githubProjectItems` table.
- Produces: `syncOrgProjects({ db, client, orgId, ownerLogin }): Promise<{ projectItems: number }>`. No watermark — Projects v2 items are fully re-upserted each sync (bounded volume; `updatedAt` filtering is unreliable for field-value changes).

- [ ] **Step 1: Write the failing integration test** (same container boilerplate; stub only `graphql`):

```ts
import { githubProjectItems } from "@caliber/db";
import { syncOrgProjects } from "../../../src/workers/githubSync/syncProjects.js";

it("upserts project items across paginated projects and items", async () => {
  const org = await insertOrg(db);
  const graphqlCalls: Array<Record<string, unknown>> = [];
  const client = {
    ...throwingClientStub(),
    graphql: async <T,>(query: string, variables: Record<string, unknown>): Promise<T> => {
      graphqlCalls.push(variables);
      if (query.includes("projectsV2(")) {
        return {
          organization: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "PVT_1", title: "Q3 Roadmap" }],
            },
          },
        } as T;
      }
      return {
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PVTI_1", type: "ISSUE", updatedAt: "2026-07-03T00:00:00Z",
                content: { __typename: "Issue", id: "I_7", assignees: { nodes: [{ databaseId: 2 }] } },
                fieldValueByName: { name: "Done" },
              },
              {
                id: "PVTI_2", type: "DRAFT_ISSUE", updatedAt: "2026-07-04T00:00:00Z",
                content: { __typename: "DraftIssue", id: "DI_1" },
                fieldValueByName: { name: "In Progress" },
              },
            ],
          },
        },
      } as T;
    },
  };

  const res = await syncOrgProjects({ db, client, orgId: org.id, ownerLogin: "acme" });
  expect(res).toEqual({ projectItems: 2 });

  const rows = (await db.select().from(githubProjectItems)).filter((r) => r.orgId === org.id);
  expect(rows).toHaveLength(2);
  const done = rows.find((r) => r.itemNodeId === "PVTI_1");
  expect(done?.isDone).toBe(true);
  expect(done?.assigneeGhIds).toEqual([2]);
  expect(done?.projectTitle).toBe("Q3 Roadmap");
  const wip = rows.find((r) => r.itemNodeId === "PVTI_2");
  expect(wip?.isDone).toBe(false);

  // Re-sync with the same data must upsert, not duplicate.
  await syncOrgProjects({ db, client, orgId: org.id, ownerLogin: "acme" });
  expect((await db.select().from(githubProjectItems)).filter((r) => r.orgId === org.id)).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration syncProjects`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `syncProjects.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration syncProjects`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/syncProjects.ts apps/gateway/tests/workers/githubSync/syncProjects.integration.test.ts
git commit -m "feat(gateway): Projects v2 item sync via GraphQL with done-status heuristic"
```

---

### Task 12: `syncOrg` orchestrator (decrypt → list → per-repo isolation → status)

**Files:**
- Create: `apps/gateway/src/workers/githubSync/syncOrg.ts`
- Test: `apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts`

**Interfaces:**
- Consumes: `decryptCredential`/`encryptCredential` + `safeErrorMessage` from `@caliber/gateway-core`, `createGithubClient` + error classes (Task 7), sync fns (Tasks 9-11), `githubConnections` table.
- Produces (used by Task 13's worker):

```ts
export interface SyncOrgResult {
  skippedReason?: "no_connection" | "disabled";
  repos: number;
  pulls: number;
  reviews: number;
  issues: number;
  projectItems: number;
  status: "ok" | "auth_error" | "rate_limited" | "sync_error";
  errors: string[];
}
export async function syncOrg(input: {
  db: Database;
  masterKeyHex: string;
  orgId: string;
  fetchImpl?: typeof fetch;
}): Promise<SyncOrgResult>
```

- [ ] **Step 1: Write the failing integration test** (container boilerplate as before; seed a connection with a REAL sealed token so decryption is exercised end-to-end):

```ts
import { encryptCredential } from "@caliber/gateway-core";
import { githubConnections, githubPullRequests, githubIssues } from "@caliber/db";
import { eq } from "drizzle-orm";
import { syncOrg } from "../../../src/workers/githubSync/syncOrg.js";

const MASTER_KEY = "ab".repeat(32); // 64 hex chars
const TOKEN = "github_pat_TESTTOKEN00000000000000";

async function insertConnection(db, orgId: string, overrides: Partial<typeof githubConnections.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const sealed = encryptCredential({ masterKeyHex: MASTER_KEY, accountId: id, plaintext: TOKEN });
  const [row] = await db.insert(githubConnections).values({
    id, orgId, ownerLogin: "acme",
    nonce: sealed.nonce, ciphertext: sealed.ciphertext, authTag: sealed.authTag,
    tokenLast4: TOKEN.slice(-4),
    ...overrides,
  }).returning();
  return row;
}

/** Route-based fake fetch: dispatch on pathname, 404 otherwise. */
function routeFetch(routes: Record<string, (url: URL) => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(url);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const PULL_DETAIL = {
  number: 1, node_id: "PR_1", state: "closed", draft: false, title: "t",
  html_url: "https://github.com/acme/web/pull/1",
  user: { id: 7, login: "h" }, base: { ref: "main" },
  additions: 1, deletions: 1, changed_files: 1, commits: 1, review_comments: 0,
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-02T00:00:00Z",
  merged_at: "2026-07-02T00:00:00Z", closed_at: "2026-07-02T00:00:00Z",
};

it("happy path: decrypts PAT, honors allowlist, syncs, sets status ok", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id, { repoAllowlist: ["acme/web"] });
  const fetchImpl = routeFetch({
    "/orgs/acme/repos": () => json([{ full_name: "acme/web" }, { full_name: "acme/api" }]),
    "/repos/acme/web/pulls/1/reviews": () => json([]),
    "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
    "/repos/acme/web/pulls": () => json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
    "/repos/acme/web/issues": () => json([]),
    "/graphql": () => json({ data: { organization: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
  });
  const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
  expect(res.status).toBe("ok");
  expect(res.repos).toBe(1); // allowlist filtered acme/api out
  expect(res.pulls).toBe(1);
  const conn = (await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0];
  expect(conn.status).toBe("ok");
  expect(conn.lastSyncAt).not.toBeNull();
  expect(conn.lastSyncError).toBeNull();
});

it("isolates per-repo failures and never leaks the token in lastSyncError", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id);
  const fetchImpl = routeFetch({
    "/orgs/acme/repos": () => json([{ full_name: "acme/bad" }, { full_name: "acme/web" }]),
    "/repos/acme/bad/pulls": () => json({ message: `boom ${TOKEN}` }, 500),
    "/repos/acme/bad/issues": () => json([]),
    "/repos/acme/web/pulls/1/reviews": () => json([]),
    "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
    "/repos/acme/web/pulls": () => json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
    "/repos/acme/web/issues": () => json([]),
    "/graphql": () => json({ data: { organization: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
  });
  const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
  expect(res.status).toBe("sync_error");
  expect(res.pulls).toBe(1); // acme/web still synced
  const conn = (await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0];
  expect(conn.status).toBe("sync_error");
  expect(conn.lastSyncError).toContain("acme/bad");
  expect(conn.lastSyncError).not.toContain(TOKEN);
});

it("401 on repo listing → auth_error, no throw", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id);
  const fetchImpl = routeFetch({
    "/orgs/acme/repos": () => json({ message: "Bad credentials" }, 401),
  });
  const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
  expect(res.status).toBe("auth_error");
  const conn = (await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0];
  expect(conn.status).toBe("auth_error");
});

it("skips when no connection or disabled", async () => {
  const org = await insertOrg(db);
  expect((await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id })).skippedReason).toBe("no_connection");
  await insertConnection(db, org.id, { deliveryEnabled: false });
  expect((await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id })).skippedReason).toBe("disabled");
});
```

Note the route ordering: `Object.entries` preserves insertion order, so `/repos/acme/web/pulls/1/reviews` MUST be listed before `/repos/acme/web/pulls/1`, which MUST precede `/repos/acme/web/pulls` (prefix matching).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration syncOrg`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `syncOrg.ts`**

```ts
/**
 * One full org sync (PR1, spec 2026-07-15).
 * Decrypt PAT (salt = connection row id) → list repos ∩ allowlist →
 * per-repo pulls+issues with failure isolation → org Projects v2 →
 * persist status. Auth/rate-limit errors abort the loop (they would
 * fail every subsequent call); other errors skip just that repo.
 * Every stored error string passes through safeErrorMessage (redaction).
 */
import { eq } from "drizzle-orm";
import { githubConnections } from "@caliber/db";
import type { Database } from "@caliber/db";
import { decryptCredential, safeErrorMessage } from "@caliber/gateway-core";
import {
  createGithubClient,
  GithubAuthError,
  GithubRateLimitError,
} from "./githubClient.js";
import { syncRepoPulls } from "./syncPulls.js";
import { syncRepoIssues } from "./syncIssues.js";
import { syncOrgProjects } from "./syncProjects.js";

const MAX_ERROR_CHARS = 2000;

export interface SyncOrgResult {
  skippedReason?: "no_connection" | "disabled";
  repos: number;
  pulls: number;
  reviews: number;
  issues: number;
  projectItems: number;
  status: "ok" | "auth_error" | "rate_limited" | "sync_error";
  errors: string[];
}

const emptyResult = (skippedReason?: SyncOrgResult["skippedReason"]): SyncOrgResult => ({
  ...(skippedReason ? { skippedReason } : {}),
  repos: 0,
  pulls: 0,
  reviews: 0,
  issues: 0,
  projectItems: 0,
  status: "ok",
  errors: [],
});

export interface SyncOrgInput {
  db: Database;
  masterKeyHex: string;
  orgId: string;
  fetchImpl?: typeof fetch;
}

export async function syncOrg(input: SyncOrgInput): Promise<SyncOrgResult> {
  const { db, masterKeyHex, orgId, fetchImpl } = input;

  const conn = (
    await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.orgId, orgId))
      .limit(1)
  )[0];
  if (!conn) return emptyResult("no_connection");
  if (!conn.deliveryEnabled) return emptyResult("disabled");

  const token = decryptCredential({
    masterKeyHex,
    accountId: conn.id,
    sealed: { nonce: conn.nonce, ciphertext: conn.ciphertext, authTag: conn.authTag },
  });
  const client = createGithubClient({ token, fetchImpl });

  let status: SyncOrgResult["status"] = "ok";
  const errors: string[] = [];
  const totals = { repos: 0, pulls: 0, reviews: 0, issues: 0, projectItems: 0 };

  const classify = (err: unknown): boolean => {
    // Returns true when the loop must abort (error affects all further calls).
    if (err instanceof GithubAuthError) {
      status = "auth_error";
      return true;
    }
    if (err instanceof GithubRateLimitError) {
      status = "rate_limited";
      return true;
    }
    if (status === "ok") status = "sync_error";
    return false;
  };

  try {
    const allRepos = await client.listRepoFullNames(conn.ownerLogin);
    const allowlist = conn.repoAllowlist as string[] | null;
    const repos = allowlist
      ? allRepos.filter((r) => allowlist.includes(r))
      : allRepos;
    totals.repos = repos.length;

    repoLoop: for (const repoFullName of repos) {
      for (const sync of [
        async () => {
          const r = await syncRepoPulls({ db, client, orgId, repoFullName });
          totals.pulls += r.pulls;
          totals.reviews += r.reviews;
        },
        async () => {
          const r = await syncRepoIssues({ db, client, orgId, repoFullName });
          totals.issues += r.issues;
        },
      ]) {
        try {
          await sync();
        } catch (err) {
          errors.push(`${repoFullName}: ${safeErrorMessage(err)}`);
          if (classify(err)) break repoLoop;
        }
      }
    }

    if (status !== "auth_error" && status !== "rate_limited") {
      try {
        const r = await syncOrgProjects({
          db,
          client,
          orgId,
          ownerLogin: conn.ownerLogin,
        });
        totals.projectItems = r.projectItems;
      } catch (err) {
        errors.push(`projects: ${safeErrorMessage(err)}`);
        classify(err);
      }
    }
  } catch (err) {
    // Repo listing failed — nothing synced this round.
    errors.push(`repos: ${safeErrorMessage(err)}`);
    classify(err);
  }

  await db
    .update(githubConnections)
    .set({
      status,
      lastSyncAt: new Date(),
      lastSyncError:
        errors.length > 0 ? errors.join(" | ").slice(0, MAX_ERROR_CHARS) : null,
      updatedAt: new Date(),
    })
    .where(eq(githubConnections.id, conn.id));

  return { ...totals, status, errors };
}
```

Check the `@caliber/gateway-core` barrel: if `decryptCredential`/`safeErrorMessage` are not re-exported from the package root, import from the same subpath other consumers use (see `apps/gateway/src/runtime/resolveCredential.ts:57`'s import line and mirror it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration syncOrg`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubSync/syncOrg.ts apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts
git commit -m "feat(gateway): syncOrg orchestrator — decrypt, allowlist, failure isolation, status"
```

---

### Task 13: Worker + 6h interval + gateway server wiring

**Files:**
- Create: `apps/gateway/src/workers/githubSync/worker.ts`
- Create: `apps/gateway/src/workers/githubSync/interval.ts`
- Modify: `apps/gateway/src/server.ts` (flag-gated wiring, after the `ENABLE_EVALUATOR` block at ~line 271)
- Test: `apps/gateway/tests/workers/githubSync/interval.integration.test.ts`
- Test: `apps/gateway/tests/workers/githubSync/worker.integration.test.ts`

**Interfaces:**
- Consumes: queue module (Task 6), `syncOrg` (Task 12), `githubConnections` + `organizations` tables.
- Produces:
  - `createGithubSyncWorker({ connection, db, masterKeyHex, concurrency?, fetchImpl? }): Worker<GithubSyncJobPayload, void>` (`fetchImpl` is a test seam threaded to `syncOrg`)
  - `GITHUB_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000`
  - `startGithubSyncInterval({ db, queue, logger, intervalMs? }): { stop(): void; tick(): Promise<void> }`

- [ ] **Step 1: Write the failing interval test** (PG container boilerplate; fake queue):

```ts
import { startGithubSyncInterval } from "../../../src/workers/githubSync/interval.js";
import { buildGithubSyncJobId } from "../../../src/workers/githubSync/queue.js";
// + insertOrg / insertConnection helpers from the syncOrg test (copy them)

it("tick enqueues one dedup'd job per enabled connection", async () => {
  const orgA = await insertOrg(db);
  const orgB = await insertOrg(db);
  const orgC = await insertOrg(db);
  await insertConnection(db, orgA.id);
  await insertConnection(db, orgB.id, { deliveryEnabled: false });
  await insertConnection(db, orgC.id);

  const added: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];
  const queue = { add: async (name, data, opts) => void added.push({ name, data, opts }) };
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

  const handle = startGithubSyncInterval({
    db, queue, logger: noopLogger,
    intervalMs: 60 * 60 * 1000, // irrelevant; we call tick() directly
  });
  added.length = 0; // discard the start-time tick — test tick() deterministically
  await handle.tick();
  // NOTE: stop() only after tick() — stop() sets the stopped flag, which
  // aborts the enqueue loop mid-flight (graceful-shutdown behavior).
  handle.stop();

  const orgIds = added.map((a) => (a.data as { orgId: string }).orgId).sort();
  expect(orgIds).toEqual([orgA.id, orgC.id].sort());
  expect(added[0].opts?.jobId).toBe(
    buildGithubSyncJobId({ orgId: (added[0].data as { orgId: string }).orgId }),
  );
  expect(added.every((a) => (a.data as { triggeredBy: string }).triggeredBy === "interval")).toBe(true);
});
```

- [ ] **Step 2: Write the failing worker end-to-end test** (PG + Redis containers, modeled on `workerRubricWiring.integration.test.ts` — real BullMQ round-trip):

```ts
import { createGithubSyncQueue, enqueueGithubSync } from "../../../src/workers/githubSync/queue.js";
import { createGithubSyncWorker } from "../../../src/workers/githubSync/worker.js";
import { githubPullRequests } from "@caliber/db";
// + insertOrg / insertConnection / routeFetch / PULL_DETAIL helpers from the syncOrg test

it("processes an enqueued job end-to-end: PAT decrypt → fetch → rows", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id);
  const fetchImpl = routeFetch({
    "/orgs/acme/repos": () => json([{ full_name: "acme/web" }]),
    "/repos/acme/web/pulls/1/reviews": () => json([]),
    "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
    "/repos/acme/web/pulls": () => json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
    "/repos/acme/web/issues": () => json([]),
    "/graphql": () => json({ data: { organization: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
  });

  const queue = createGithubSyncQueue({ connection: redisConnection });
  const worker = createGithubSyncWorker({
    connection: redisConnection, db, masterKeyHex: MASTER_KEY, fetchImpl,
  });
  try {
    await enqueueGithubSync(queue, { orgId: org.id, triggeredBy: "manual" });
    // Poll until the row lands (worker is async); 15s budget.
    const deadline = Date.now() + 15_000;
    let rows: Array<{ orgId: string }> = [];
    while (Date.now() < deadline) {
      rows = (await db.select().from(githubPullRequests)).filter((r) => r.orgId === org.id);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(rows).toHaveLength(1);
  } finally {
    await worker.close();
    await queue.close();
  }
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm --filter @caliber/gateway test:integration githubSync/interval githubSync/worker`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write `worker.ts`**

```ts
/**
 * github-sync worker (PR1). Concurrency 1: one org sync at a time —
 * network-bound and per-org rate-limited; parallelism buys nothing here.
 */
import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  GITHUB_SYNC_QUEUE_NAME,
  GITHUB_SYNC_QUEUE_PREFIX,
  GithubSyncJobPayload,
} from "./queue.js";
import { syncOrg } from "./syncOrg.js";

export interface CreateGithubSyncWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export function createGithubSyncWorker(
  opts: CreateGithubSyncWorkerOptions,
): Worker<GithubSyncJobPayload, void> {
  return new Worker<GithubSyncJobPayload, void>(
    GITHUB_SYNC_QUEUE_NAME,
    async (job) => {
      const payload = GithubSyncJobPayload.parse(job.data);
      const result = await syncOrg({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        orgId: payload.orgId,
        fetchImpl: opts.fetchImpl,
      });
      // Spec: rate-limited syncs reschedule themselves. Watermarks already
      // advanced for completed repos; throwing hands the retry to BullMQ's
      // exponential backoff (attempts: 3).
      if (result.status === "rate_limited") {
        throw new Error("github rate limited; retrying via job backoff");
      }
    },
    {
      connection: opts.connection,
      prefix: GITHUB_SYNC_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 1,
    } satisfies WorkerOptions,
  );
}
```

- [ ] **Step 5: Write `interval.ts`** (setInterval pattern — repo convention per `evaluator/cron.ts:24-26`; no cron parser):

```ts
/**
 * 6-hourly github-sync scheduler (PR1). Same interval pattern as
 * evaluator/cron.ts (bodyPurge, billingAudit): run once at start,
 * then on a fixed interval; deterministic jobIds dedup overlaps.
 */
import { and, eq, isNull } from "drizzle-orm";
import { githubConnections, organizations } from "@caliber/db";
import type { Database } from "@caliber/db";
import { enqueueGithubSync, type QueueLike } from "./queue.js";

export const GITHUB_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface StartGithubSyncIntervalOptions {
  db: Database;
  queue: QueueLike;
  logger: LoggerLike;
  intervalMs?: number;
}

export interface GithubSyncCronHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startGithubSyncInterval(
  opts: StartGithubSyncIntervalOptions,
): GithubSyncCronHandle {
  const interval = opts.intervalMs ?? GITHUB_SYNC_INTERVAL_MS;
  let stopped = false;

  async function tick(): Promise<void> {
    const rows = await opts.db
      .select({ orgId: githubConnections.orgId })
      .from(githubConnections)
      .innerJoin(organizations, eq(githubConnections.orgId, organizations.id))
      .where(
        and(
          eq(githubConnections.deliveryEnabled, true),
          isNull(organizations.deletedAt),
        ),
      );
    for (const row of rows) {
      if (stopped) return;
      try {
        await enqueueGithubSync(opts.queue, {
          orgId: row.orgId,
          triggeredBy: "interval",
        });
      } catch (err) {
        opts.logger.error({ err, orgId: row.orgId }, "github-sync enqueue failed");
      }
    }
    if (rows.length > 0) {
      opts.logger.info({ orgs: rows.length }, "github-sync tick enqueued");
    }
  }

  const runTick = (): Promise<void> =>
    tick().catch((err) => opts.logger.error({ err }, "github-sync tick failed"));

  let currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: async () => {
      await currentTick;
      await tick();
    },
  };
}
```

- [ ] **Step 6: Wire into `apps/gateway/src/server.ts`** — after the `ENABLE_EVALUATOR` block (~line 271-323), add:

```ts
if (opts.env.ENABLE_GITHUB_DELIVERY) {
  await wireGithubSyncPipeline(app, opts.env);
}
```

and at file bottom (next to `wireEvaluatorPipeline`, ~line 582) add the wiring function, mirroring its Redis/onClose handling exactly:

```ts
async function wireGithubSyncPipeline(
  app: AppInstance,
  env: ServerEnv,
): Promise<void> {
  if (!env.REDIS_URL) {
    throw new Error("ENABLE_GITHUB_DELIVERY requires REDIS_URL");
  }
  const masterKeyHex = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!masterKeyHex) {
    throw new Error("ENABLE_GITHUB_DELIVERY requires CREDENTIAL_ENCRYPTION_KEY");
  }

  const githubRedis = new Redis(env.REDIS_URL, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });
  githubRedis.on("error", (err) => {
    app.log.warn({ err }, "github-sync redis error");
  });

  const queue = createGithubSyncQueue({ connection: githubRedis });
  const worker = createGithubSyncWorker({
    connection: githubRedis,
    db: app.db,
    masterKeyHex,
  });
  const cronHandle = startGithubSyncInterval({
    db: app.db,
    queue,
    logger: app.log,
  });

  app.addHook("onClose", async () => {
    cronHandle.stop();
    try {
      await worker.close();
    } catch (err) {
      app.log.warn({ err }, "github-sync worker close failed");
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.debug({ err }, "github-sync queue close failed");
    }
    try {
      await githubRedis.quit();
    } catch (err) {
      app.log.debug({ err }, "github-sync redis quit failed");
    }
  });
}
```

(Use the same `AppInstance`/type name `wireEvaluatorPipeline` uses for its first parameter — copy its exact signature. Add the three imports next to the evaluator worker imports at the top of `server.ts`.)

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @caliber/gateway test:integration githubSync/interval githubSync/worker && pnpm --filter @caliber/gateway typecheck`
Expected: both integration tests PASS; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/workers/githubSync/ apps/gateway/src/server.ts apps/gateway/tests/workers/githubSync/
git commit -m "feat(gateway): github-sync worker + 6h interval, wired behind ENABLE_GITHUB_DELIVERY"
```

---

### Task 14: API surface — gate, probe service, `githubDelivery` router, queue injection

**Files:**
- Create: `apps/api/src/trpc/routers/_githubGate.ts`
- Create: `apps/api/src/services/githubProbe.ts`
- Create: `apps/api/src/trpc/routers/githubDelivery.ts`
- Modify: `apps/api/src/trpc/router.ts` (import + register `githubDelivery`)
- Modify: `apps/api/src/trpc/context.ts` (optional `githubSyncQueue` ctx field, mirroring `evaluatorQueue`)
- Modify: `apps/api/src/server.ts` (queue creation when `ENABLE_GITHUB_DELIVERY && REDIS_URL`, mirroring the evaluator queue block at ~lines 141-163)
- Test: `apps/api/tests/unit/githubProbe.test.ts` (if `apps/api/vitest.config.ts` include-globs don't match `tests/unit/`, place it wherever the existing non-integration tests live — check the glob first)
- Test: `apps/api/tests/integration/trpc/githubDelivery.test.ts`

**Interfaces:**
- Consumes: `can` + `github.manage` (Task 4), `requireMasterKeyHex` (`./_credentials.js`), `encryptCredential` (`@caliber/gateway-core`), `githubConnections` (Task 1), flag (Task 3).
- Produces:
  - `githubProcedure` (404s when flag off)
  - `probeGithubToken({ token, ownerLogin, fetchImpl? }): Promise<{ sampleRepo: string | null }>` / `GithubProbeError` with `reason: "bad_token" | "owner_not_found" | "network"`
  - `githubDeliveryRouter` with `setConnection` / `getConnection` / `deleteConnection` / `syncNow`
  - ctx field `githubSyncQueue?: { add(name, data, opts?) }`

- [ ] **Step 1: Write `_githubGate.ts`** (mirror `_evaluatorGate.ts:9-16`):

```ts
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../procedures.js";

/** github-delivery procedures 404 (anti-enumeration) when the flag is off. */
export const githubProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.env.ENABLE_GITHUB_DELIVERY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return next();
});
```

- [ ] **Step 2: Write the failing probe unit test**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  probeGithubToken,
  GithubProbeError,
} from "../../src/services/githubProbe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fetchQueue(...responses: Array<Response | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn as unknown as typeof fetch;
}

const INPUT = { token: "github_pat_TESTTOKEN00000000000000", ownerLogin: "acme" };

describe("probeGithubToken", () => {
  it("returns a sample repo on success", async () => {
    const fetchImpl = fetchQueue(
      json({ login: "bot" }),
      json([{ full_name: "acme/web" }]),
    );
    const res = await probeGithubToken({ ...INPUT, fetchImpl });
    expect(res).toEqual({ sampleRepo: "acme/web" });
  });

  it("401 on /user → bad_token", async () => {
    const fetchImpl = fetchQueue(json({ message: "Bad credentials" }, 401));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubProbeError);
    expect((err as GithubProbeError).reason).toBe("bad_token");
    expect((err as GithubProbeError).message).not.toContain(INPUT.token);
  });

  it("404 on org repos → owner_not_found", async () => {
    const fetchImpl = fetchQueue(json({}), json({ message: "Not Found" }, 404));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect((err as GithubProbeError).reason).toBe("owner_not_found");
  });

  it("fetch rejection → network", async () => {
    const fetchImpl = fetchQueue(new TypeError("fetch failed"));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect((err as GithubProbeError).reason).toBe("network");
  });
});
```

Run: `pnpm --filter @caliber/api test githubProbe` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `githubProbe.ts`**

```ts
/**
 * Live PAT validation before persisting a GitHub connection (PR1).
 * Two GETs: /user (token valid?) and /orgs/{owner}/repos?per_page=1
 * (owner visible + repo read?). Error messages NEVER include the token.
 */
export type GithubProbeFailure = "bad_token" | "owner_not_found" | "network";

export class GithubProbeError extends Error {
  constructor(
    public readonly reason: GithubProbeFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface ProbeGithubTokenInput {
  token: string;
  ownerLogin: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function probeGithubToken(
  input: ProbeGithubTokenInput,
): Promise<{ sampleRepo: string | null }> {
  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${input.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "caliber-api",
  };

  async function get(path: string): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, { method: "GET", headers });
    } catch {
      throw new GithubProbeError("network", `github unreachable for ${path}`);
    }
  }

  const userRes = await get("/user");
  if (userRes.status === 401 || userRes.status === 403) {
    throw new GithubProbeError("bad_token", "github rejected the token");
  }
  if (!userRes.ok) {
    throw new GithubProbeError("network", `github /user returned ${userRes.status}`);
  }

  const repoRes = await get(`/orgs/${input.ownerLogin}/repos?per_page=1`);
  if (repoRes.status === 404) {
    throw new GithubProbeError(
      "owner_not_found",
      `github org '${input.ownerLogin}' not visible to this token`,
    );
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    throw new GithubProbeError("bad_token", "token lacks repo read on the org");
  }
  if (!repoRes.ok) {
    throw new GithubProbeError("network", `github repos returned ${repoRes.status}`);
  }
  const repos = (await repoRes.json()) as Array<{ full_name: string }>;
  return { sampleRepo: repos[0]?.full_name ?? null };
}
```

Run: `pnpm --filter @caliber/api test githubProbe` — Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing router integration test** — local sub-router pattern copied from `apps/api/tests/integration/trpc/reports.mutations.test.ts:32-68` (same `callerFor` shape, plus a `githubSyncQueue` field):

```ts
// Setup: copy the localRouter/callerFor/beforeAll block from
// reports.mutations.test.ts, swapping in githubDeliveryRouter and adding
// `githubSyncQueue` to the ctx the same way it adds `evaluatorQueue`.
// const envWithFlag = { ...defaultTestEnv, ENABLE_GITHUB_DELIVERY: true };
import { githubConnections } from "@caliber/db";
import { eq } from "drizzle-orm";

const TOKEN = "github_pat_LIVETOKEN000000000000000";

/** Probe fetch stub: /user ok, /orgs/.../repos ok with one repo. */
function stubProbeFetch(ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (!ok) return new Response("{}", { status: 401 });
      if (path === "/user") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify([{ full_name: "acme/web" }]), { status: 200 });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

it("404s when the flag is off", async () => {
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: admin.id, env: defaultTestEnv }); // flag off
  await expect(caller.githubDelivery.getConnection({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("FORBIDDEN for a plain member", async () => {
  const org = await makeOrg(t.db);
  const member = await makeUser(t.db, { orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
  await expect(
    caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("setConnection probes, encrypts at rest, and never returns the token", async () => {
  stubProbeFetch(true);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });

  const res = await caller.githubDelivery.setConnection({
    orgId: org.id, ownerLogin: "acme", token: TOKEN, repoAllowlist: ["acme/web"],
  });
  expect(res).toEqual({ ownerLogin: "acme", tokenLast4: TOKEN.slice(-4), sampleRepo: "acme/web" });
  expect(JSON.stringify(res)).not.toContain(TOKEN);

  const row = (await t.db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0];
  expect(row.ciphertext.toString("utf8")).not.toContain(TOKEN); // encrypted at rest
  expect(row.tokenLast4).toBe(TOKEN.slice(-4));

  const got = await caller.githubDelivery.getConnection({ orgId: org.id });
  expect(got).toMatchObject({ ownerLogin: "acme", tokenLast4: TOKEN.slice(-4), status: "ok" });
  expect(JSON.stringify(got)).not.toContain(TOKEN);

  // Update path: same org, new token — row id (encryption salt) must be reused.
  const res2 = await caller.githubDelivery.setConnection({
    orgId: org.id, ownerLogin: "acme", token: `${TOKEN}X2`,
  });
  expect(res2.tokenLast4).toBe(`${TOKEN}X2`.slice(-4));
  const rows = await t.db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(row.id);
});

it("rejects a bad token with BAD_REQUEST", async () => {
  stubProbeFetch(false);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
  await expect(
    caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("syncNow enqueues with a colon-free jobId; testMode without a queue", async () => {
  stubProbeFetch(true);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const added: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];
  const queue = { add: async (name, data, opts) => void added.push({ name, data, opts }) };

  const withQueue = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag, githubSyncQueue: queue });
  await withQueue.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });
  const res = await withQueue.githubDelivery.syncNow({ orgId: org.id });
  expect(res.enqueued).toBe(true);
  expect(added[0].opts?.jobId).not.toContain(":");
  expect(added[0].data).toEqual({ orgId: org.id, triggeredBy: "manual" });

  const noQueue = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
  expect(await noQueue.githubDelivery.syncNow({ orgId: org.id })).toMatchObject({ testMode: true });
});

it("deleteConnection removes the row; syncNow then 404s", async () => {
  stubProbeFetch(true);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
  await caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });
  expect(await caller.githubDelivery.deleteConnection({ orgId: org.id })).toEqual({ deleted: true });
  await expect(caller.githubDelivery.syncNow({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
```

Run: `pnpm --filter @caliber/api test:integration githubDelivery` — Expected: FAIL (router not found).

- [ ] **Step 5: Write `githubDelivery.ts`**

```ts
/**
 * GitHub delivery connection management (PR1, spec 2026-07-15).
 * Admin-gated via RBAC action github.manage (org_admin only).
 * The PAT is write-only: sealed with encryptCredential (salt = row id)
 * and never returned or logged. Queue constants are duplicated from the
 * gateway module (same precedent as reports.ts:27-28 — TODO @caliber/queue).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { can } from "@caliber/auth";
import { githubConnections } from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";
import { router } from "../procedures.js";
import { githubProcedure } from "./_githubGate.js";
import { requireMasterKeyHex } from "./_credentials.js";
import {
  probeGithubToken,
  GithubProbeError,
} from "../../services/githubProbe.js";

const GITHUB_SYNC_JOB_NAME = "github-sync";
/** Keep in lockstep with apps/gateway/src/workers/githubSync/queue.ts. */
function buildGithubSyncJobId(input: { orgId: string }): string {
  return ["ghsync", "v1", input.orgId].join("_").replaceAll(":", "-");
}

export interface GithubSyncQueue {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
}

const orgIdInput = z.object({ orgId: z.string().uuid() });
const OWNER_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function assertCanManage(
  perm: Parameters<typeof can>[0],
  orgId: string,
): void {
  if (!can(perm, { type: "github.manage", orgId })) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

export const githubDeliveryRouter = router({
  setConnection: githubProcedure
    .input(
      orgIdInput.extend({
        ownerLogin: z.string().regex(OWNER_LOGIN_REGEX),
        token: z.string().min(20).max(255),
        repoAllowlist: z.array(z.string().min(3).max(200)).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCanManage(ctx.perm, input.orgId);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      let probe: { sampleRepo: string | null };
      try {
        probe = await probeGithubToken({
          token: input.token,
          ownerLogin: input.ownerLogin,
        });
      } catch (err) {
        if (err instanceof GithubProbeError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `github connection probe failed: ${err.reason}`,
          });
        }
        throw err;
      }

      const existing = (
        await ctx.db
          .select({ id: githubConnections.id })
          .from(githubConnections)
          .where(eq(githubConnections.orgId, input.orgId))
          .limit(1)
      )[0];
      // Salt binding: sealed with the row id — reuse it on update.
      const id = existing?.id ?? randomUUID();
      const sealed = encryptCredential({
        masterKeyHex,
        accountId: id,
        plaintext: input.token,
      });
      const tokenLast4 = input.token.slice(-4);

      await ctx.db
        .insert(githubConnections)
        .values({
          id,
          orgId: input.orgId,
          ownerLogin: input.ownerLogin,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          tokenLast4,
          repoAllowlist: input.repoAllowlist ?? null,
        })
        .onConflictDoUpdate({
          target: githubConnections.orgId,
          set: {
            ownerLogin: input.ownerLogin,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            tokenLast4,
            repoAllowlist: input.repoAllowlist ?? null,
            status: "ok",
            lastSyncError: null,
            updatedAt: new Date(),
          },
        });

      return {
        ownerLogin: input.ownerLogin,
        tokenLast4,
        sampleRepo: probe.sampleRepo,
      };
    }),

  getConnection: githubProcedure.input(orgIdInput).query(async ({ ctx, input }) => {
    assertCanManage(ctx.perm, input.orgId);
    const row = (
      await ctx.db
        .select({
          ownerLogin: githubConnections.ownerLogin,
          tokenLast4: githubConnections.tokenLast4,
          repoAllowlist: githubConnections.repoAllowlist,
          deliveryEnabled: githubConnections.deliveryEnabled,
          status: githubConnections.status,
          lastSyncAt: githubConnections.lastSyncAt,
          lastSyncError: githubConnections.lastSyncError,
        })
        .from(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .limit(1)
    )[0];
    return row ?? null;
  }),

  deleteConnection: githubProcedure
    .input(orgIdInput)
    .mutation(async ({ ctx, input }) => {
      assertCanManage(ctx.perm, input.orgId);
      const deleted = await ctx.db
        .delete(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .returning({ id: githubConnections.id });
      return { deleted: deleted.length > 0 };
    }),

  syncNow: githubProcedure.input(orgIdInput).mutation(async ({ ctx, input }) => {
    assertCanManage(ctx.perm, input.orgId);
    const exists = (
      await ctx.db
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .limit(1)
    )[0];
    if (!exists) throw new TRPCError({ code: "NOT_FOUND" });

    const queue = ctx.githubSyncQueue;
    if (!queue) return { enqueued: false, testMode: true as const };

    const jobId = buildGithubSyncJobId({ orgId: input.orgId });
    await queue.add(
      GITHUB_SYNC_JOB_NAME,
      { orgId: input.orgId, triggeredBy: "manual" },
      { jobId },
    );
    return { enqueued: true as const, jobId };
  }),
});
```

If `ctx.perm`'s type makes `Parameters<typeof can>[0]` awkward, type `assertCanManage(perm: UserPermissions, …)` importing `UserPermissions` from `@caliber/auth` (the way `reports.ts` types it).

- [ ] **Step 6: Wire context + server + root router**

1. `apps/api/src/trpc/context.ts`: add `githubSyncQueue?: GithubSyncQueue` to the context type and thread it through `createContextFactory` opts — copy exactly how `evaluatorQueue` flows (`context.ts:51,94`). Import the `GithubSyncQueue` type from `../trpc/routers/githubDelivery.js` (type-only import).
2. `apps/api/src/server.ts`: next to the evaluator queue block (~lines 141-163), add:

First, hoist the evaluator block's BullMQ Redis variable so both queues can share it (it is currently scoped to the `ENABLE_EVALUATOR && REDIS_URL` branch). Then:

```ts
let githubSyncQueue: Queue | undefined;
if (env.ENABLE_GITHUB_DELIVERY && env.REDIS_URL) {
  // bullmqRedis: the SAME ioredis instance the evaluator block creates
  // (hoisted above both blocks); when ENABLE_EVALUATOR is off, create it
  // here with the identical options that block uses
  // ({ enableAutoPipelining: true, maxRetriesPerRequest: null }).
  githubSyncQueue = new Queue("github-sync", {
    prefix: "caliber:gw",
    connection: bullmqRedis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86400, count: 500 },
      removeOnFail: { age: 7 * 86400 },
    },
  });
}
```

then pass `githubSyncQueue` into `createContextFactory({ env, redis, evaluatorQueue, githubSyncQueue })`, and close `githubSyncQueue` (and the Redis instance, if this block created it) in the same shutdown path that closes `evaluatorQueue`.

3. `apps/api/src/trpc/router.ts`: `import { githubDeliveryRouter } from "./routers/githubDelivery.js";` and add `githubDelivery: githubDeliveryRouter,` to the `router({...})` map.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @caliber/api test:integration githubDelivery && pnpm --filter @caliber/api typecheck`
Expected: PASS (6 tests); typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/
git add apps/api/tests/
git commit -m "feat(api): githubDelivery router — PAT set/get/delete + syncNow, github.manage gated"
```

---

### Task 15: Full verification + PR

**Files:** none new — verification and PR only.

- [ ] **Step 1: Full workspace verification**

Run, in order (all must exit 0):

```bash
pnpm turbo run lint typecheck test
pnpm --filter @caliber/gateway test:integration
pnpm --filter @caliber/api test:integration
```

Expected: all green. If anything fails, fix before proceeding — do NOT skip.

- [ ] **Step 2: Grep-audit for token leaks** (defense in depth on top of the tests):

```bash
grep -rn "input.token" apps/api/src/trpc/routers/githubDelivery.ts | grep -v "encryptCredential\|probeGithubToken\|slice(-4)\|min(20)\|max(255)"
```

Expected: no output (the raw token only flows into encrypt/probe/last4).

- [ ] **Step 3: Push and open the PR**

⚠️ gh account gotcha (repo memory): the active account reverts to one without repo write — switch first:

```bash
gh auth switch --user hanfour && gh auth setup-git
git push -u origin feat/github-delivery-pr1-sync
```

PR body per repo convention (TL;DR / Why / What / Tests with counts / Verification / Out of scope). Reference the spec as `docs/superpowers/specs/2026-07-15-github-delivery-scoring-design.md`. State that the feature is DARK (`ENABLE_GITHUB_DELIVERY=false` everywhere) and that PR 2 (quant scoring), PR 3 (LLM layer), PR 4 (UI) follow. Do NOT write `Close #NN` anywhere.

- [ ] **Step 4: Invoke superpowers:requesting-code-review** before merging.

---

## Spec coverage note (what PR 1 deliberately does NOT include)

Deferred to later plans, per the spec's delivery order — do not "helpfully" add them here:

- **PR 2:** delivery rubric + metrics + `continuousScorer` reuse, `github_delivery_reports` writes, `generate`/`getReport`/`listActivity` procedures, weekly report cron, 92-day window cap.
- **PR 3:** LLM quality layer (sampling, diff fetch, loopback + eval pin header, `llm_usage_events` `delivery_analysis` events, ±15 clamp, parse_error resilience).
- **PR 4:** all web UI (delivery tab, leaderboard column, settings screen) + i18n catalogs.

The `github_delivery_reports` TABLE ships now (migration 0032 is complete in one shot); its writers arrive in PR 2/3.

## Execution notes

- Integration tests spin their own testcontainers per file (repo convention — no shared helper). Docker must be running.
- The `insertOrg` helper: copy the org-insert used by `apps/gateway/tests/workers/evaluator/workerRubricWiring.integration.test.ts` verbatim; `organizations` may require more than `name` (slug etc.) — that file is the source of truth.
- If `@caliber/gateway-core` doesn't re-export `encryptCredential`/`decryptCredential`/`safeErrorMessage` from its root, mirror the import specifiers used at the existing call sites (`apps/api/src/trpc/routers/accounts.ts:157`, `apps/gateway/src/runtime/resolveCredential.ts:57`).
- Cross-package type changes require dependents rebuilt — Turbo handles it, but a stale editor TS server may lie; trust `pnpm --filter <pkg> typecheck`.
