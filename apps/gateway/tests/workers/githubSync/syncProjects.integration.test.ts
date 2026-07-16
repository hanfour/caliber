/**
 * Integration tests for PR1 Task 11: Projects v2 item sync (GraphQL).
 *
 * Exercises `syncOrgProjects` against a real Postgres testcontainer (migrated
 * schema) with a `GithubClient` STUB — no fetch, no HTTP mocking. Container +
 * migrate boilerplate and the `insertOrg` helper are copied verbatim (module
 * paths + slug prefix aside) from
 * apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts, and
 * `throwingClientStub()` from
 * apps/gateway/tests/workers/githubSync/syncIssues.integration.test.ts
 * (this suite's conventions come from those two files).
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
  githubProjectItems,
  type Database,
} from "@caliber/db";
import { syncOrgProjects } from "../../../src/workers/githubSync/syncProjects.js";
import type { GithubClient } from "../../../src/workers/githubSync/githubClient.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

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
      slug: `sync-projects-test-org-${suffix}`,
      name: `Sync Projects Test Org ${suffix}`,
    })
    .returning();
  return org!;
}

/** GithubClient stub whose every method rejects — tests override only the
 * methods `syncOrgProjects` is expected to call. */
function throwingClientStub(): GithubClient {
  return {
    listRepoFullNames: async () => {
      throw new Error("unused");
    },
    listPullsSince: async () => {
      throw new Error("unused");
    },
    getPull: async () => {
      throw new Error("unused");
    },
    getPullDiff: async () => {
      throw new Error("unused");
    },
    listReviews: async () => {
      throw new Error("unused");
    },
    listReviewComments: async () => {
      throw new Error("unused");
    },
    listIssuesSince: async () => {
      throw new Error("unused");
    },
    getIssue: async () => {
      throw new Error("unused");
    },
    graphql: async () => {
      throw new Error("unused");
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("syncOrgProjects", () => {
  it("upserts project items across paginated projects and items", async () => {
    const org = await insertOrg(db);
    const graphqlCalls: Array<Record<string, unknown>> = [];
    const client = {
      ...throwingClientStub(),
      graphql: async <T,>(
        query: string,
        variables: Record<string, unknown>,
      ): Promise<T> => {
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
});
