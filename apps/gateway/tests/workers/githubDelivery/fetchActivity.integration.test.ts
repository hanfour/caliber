/**
 * Integration tests for PR2 Task 6: attribution + activity fetch.
 *
 * Exercises `resolveGithubUserId` and `fetchDeliveryActivity` against a real
 * Postgres testcontainer (migrated schema). Container + migrate boilerplate
 * and `insertOrg` copied from
 * apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import {
  organizations,
  accounts,
  users,
  githubPullRequests,
  githubReviews,
  githubIssues,
  githubProjectItems,
  type Database,
} from "@caliber/db";
import {
  resolveGithubUserId,
  fetchDeliveryActivity,
} from "../../../src/workers/githubDelivery/fetchActivity.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const WINDOW = {
  start: new Date("2026-06-16T00:00:00Z"),
  end: new Date("2026-07-16T00:00:00Z"),
};

// ── Containers + shared state ────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();

  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a fresh org (unique slug per call — each `it` seeds its own). */
async function insertOrg(db: Database) {
  const suffix = Math.random().toString(36).slice(2);
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `fetch-activity-test-org-${suffix}`,
      name: `Fetch Activity Test Org ${suffix}`,
    })
    .returning();
  return org!;
}

/** Seed a user + linked github account row. */
async function insertMember(db: Database, ghId: number) {
  const [u] = await db
    .insert(users)
    .values({
      email: `m${ghId}-${Math.random().toString(36).slice(2)}@t.test`,
      name: "m",
    })
    .returning();
  await db.insert(accounts).values({
    userId: u!.id,
    type: "oauth",
    provider: "github",
    providerAccountId: String(ghId),
  });
  return u!;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fetchActivity", () => {
  it("resolveGithubUserId maps the github account row; null when absent or non-numeric", async () => {
    const u = await insertMember(db, 777);
    expect(await resolveGithubUserId(db, u.id)).toBe(777);

    const [noGh] = await db
      .insert(users)
      .values({ email: `x-${Math.random().toString(36).slice(2)}@t.test`, name: "x" })
      .returning();
    expect(await resolveGithubUserId(db, noGh!.id)).toBeNull();

    const [badGh] = await db
      .insert(users)
      .values({ email: `y-${Math.random().toString(36).slice(2)}@t.test`, name: "y" })
      .returning();
    await db.insert(accounts).values({
      userId: badGh!.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "not-a-number",
    });
    expect(await resolveGithubUserId(db, badGh!.id)).toBeNull();
  });

  it("fetchDeliveryActivity narrows by org/window/author and joins review→PR author", async () => {
    const org = await insertOrg(db);
    const otherOrg = await insertOrg(db);
    const base = {
      orgId: org.id,
      repoFullName: "acme/web",
      state: "closed",
      title: "t",
      htmlUrl: "u",
      baseRef: "main",
      ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
    };

    await db.insert(githubPullRequests).values([
      {
        ...base,
        number: 1,
        ghNodeId: "PR_1",
        authorGhId: 777,
        authorLogin: "me",
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        ...base,
        number: 2,
        ghNodeId: "PR_2",
        authorGhId: 999,
        authorLogin: "other",
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      }, // other author → excluded by SQL
      {
        ...base,
        number: 3,
        ghNodeId: "PR_3",
        authorGhId: 777,
        authorLogin: "me",
        mergedAt: new Date("2026-05-01T00:00:00Z"),
      }, // out of window
      {
        ...base,
        orgId: otherOrg.id,
        number: 4,
        ghNodeId: "PR_4",
        authorGhId: 777,
        authorLogin: "me",
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      }, // other org
    ]);
    await db.insert(githubReviews).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_1",
        prGhNodeId: "PR_2",
        reviewerGhId: 777,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-03T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_2",
        prGhNodeId: "PR_MISSING",
        reviewerGhId: 777,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-03T00:00:00Z"),
      }, // PR row absent → prAuthorGhId null
    ]);
    await db.insert(githubIssues).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 7,
        ghNodeId: "I_7",
        assigneeGhIds: [777],
        state: "closed",
        title: "i",
        htmlUrl: "u",
        ghCreatedAt: new Date("2026-06-30T00:00:00Z"),
        closedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 8,
        ghNodeId: "I_8",
        assigneeGhIds: "garbage" as never,
        state: "closed",
        title: "i",
        htmlUrl: "u",
        ghCreatedAt: new Date("2026-06-30T00:00:00Z"),
        closedAt: new Date("2026-07-02T00:00:00Z"),
      }, // malformed jsonb → sanitized to []
    ]);
    await db.insert(githubProjectItems).values([
      {
        orgId: org.id,
        projectNodeId: "PVT_1",
        projectTitle: "Q3",
        itemNodeId: "PVTI_1",
        contentType: "ISSUE",
        assigneeGhIds: [777],
        statusValue: "Done",
        isDone: true,
        ghUpdatedAt: new Date("2026-07-05T00:00:00Z"),
      },
      {
        orgId: org.id,
        projectNodeId: "PVT_1",
        projectTitle: "Q3",
        itemNodeId: "PVTI_2",
        contentType: "ISSUE",
        assigneeGhIds: [777],
        statusValue: "Todo",
        isDone: false,
        ghUpdatedAt: new Date("2026-07-05T00:00:00Z"),
      }, // not done → excluded by SQL
    ]);

    const a = await fetchDeliveryActivity(db, {
      orgId: org.id,
      ghUserId: 777,
      window: WINDOW,
    });
    expect(a.pulls.map((p) => p.ghNodeId)).toEqual(["PR_1"]);
    expect(a.reviews).toHaveLength(2);
    expect(a.reviews.find((r) => r.prGhNodeId === "PR_2")!.prAuthorGhId).toBe(999);
    expect(
      a.reviews.find((r) => r.prGhNodeId === "PR_MISSING")!.prAuthorGhId,
    ).toBeNull();
    expect(a.issues).toHaveLength(2);
    expect(a.issues.find((i) => i.assigneeGhIds.length === 0)).toBeDefined(); // sanitized garbage
    expect(a.projectItems).toHaveLength(1);
  });
});
