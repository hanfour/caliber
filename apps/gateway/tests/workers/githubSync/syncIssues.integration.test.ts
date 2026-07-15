/**
 * Integration tests for PR1 Task 10: issue sync.
 *
 * Exercises `syncRepoIssues` against a real Postgres testcontainer (migrated
 * schema) with a `GithubClient` STUB — no fetch, no HTTP mocking. Container +
 * migrate boilerplate and the `insertOrg` helper are copied verbatim (module
 * paths + slug prefix aside) from
 * apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts
 * (Task 9's file — local source of truth for this suite's conventions).
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
import { organizations, githubIssues, type Database } from "@caliber/db";
import { syncRepoIssues } from "../../../src/workers/githubSync/syncIssues.js";
import { getWatermark } from "../../../src/workers/githubSync/watermarks.js";
import type {
  GithubClient,
  GithubApiIssue,
} from "../../../src/workers/githubSync/githubClient.js";

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
      slug: `sync-issues-test-org-${suffix}`,
      name: `Sync Issues Test Org ${suffix}`,
    })
    .returning();
  return org!;
}

/** GithubClient stub whose every method rejects — tests override only the
 * methods `syncRepoIssues` is expected to call. */
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
    listReviews: async () => {
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const openIssue: GithubApiIssue = {
  number: 1,
  node_id: "I_1",
  state: "open",
  state_reason: null,
  title: "a",
  html_url: "https://github.com/acme/web/issues/1",
  user: { id: 1, login: "a" },
  assignees: [],
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  closed_at: null,
};
// List payloads omit closed_by — the sync must fetch the detail for closed issues.
const closedListItem: GithubApiIssue = {
  number: 2,
  node_id: "I_2",
  state: "closed",
  state_reason: "completed",
  title: "b",
  html_url: "https://github.com/acme/web/issues/2",
  user: { id: 1, login: "a" },
  assignees: [{ id: 2, login: "b" }],
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: "2026-07-03T00:00:00Z",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("syncRepoIssues", () => {
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
    const res = await syncRepoIssues({
      db,
      client,
      orgId: org.id,
      repoFullName: "acme/web",
    });
    expect(res).toEqual({ issues: 2 });
    expect(getIssueCalls).toEqual([2]); // only the closed issue

    const rows = (await db.select().from(githubIssues)).filter(
      (r) => r.orgId === org.id,
    );
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
    const client1 = {
      ...throwingClientStub(),
      listIssuesSince: async () => [base],
      getIssue: async () => base,
    };
    await syncRepoIssues({
      db,
      client: client1,
      orgId: org.id,
      repoFullName: "acme/web",
    });
    const closedNow = {
      ...base,
      state: "closed" as const,
      state_reason: "completed",
      closed_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-05T00:00:00Z",
    };
    const client2 = {
      ...throwingClientStub(),
      listIssuesSince: async () => [closedNow],
      getIssue: async () => ({ ...closedNow, closed_by: { id: 9, login: "z" } }),
    };
    await syncRepoIssues({
      db,
      client: client2,
      orgId: org.id,
      repoFullName: "acme/web",
    });

    const rows = (await db.select().from(githubIssues)).filter(
      (r) => r.orgId === org.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.closedByGhId).toBe(9);
  });
});
