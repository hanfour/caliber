/**
 * Integration tests for PR1 Task 9: watermarks + PR/review sync.
 *
 * Exercises `syncRepoPulls` against a real Postgres testcontainer (migrated
 * schema) with a `GithubClient` STUB — no fetch, no HTTP mocking. The stub
 * implements the `GithubClient` interface directly with in-memory fixtures,
 * per the repo's github-sync test conventions (see githubClient.test.ts /
 * mappers.test.ts).
 *
 * Container + migrate boilerplate copied from
 * apps/gateway/tests/workers/evaluator/workerRubricWiring.integration.test.ts:25-45
 * (Postgres only — no Redis needed for this task). The `insertOrg` helper's
 * insert statement mirrors that file's org-insert (organizations requires
 * `slug` + `name`; `slug` must be unique per insert since each `it` block
 * seeds its own org).
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
  githubPullRequests,
  githubReviews,
  type Database,
} from "@caliber/db";
import {
  getWatermark,
  setWatermark,
} from "../../../src/workers/githubSync/watermarks.js";
import { syncRepoPulls } from "../../../src/workers/githubSync/syncPulls.js";
import type {
  GithubClient,
  GithubApiPullDetail,
} from "../../../src/workers/githubSync/githubClient.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const REPO = "acme/web";

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
      slug: `sync-pulls-test-org-${suffix}`,
      name: `Sync Pulls Test Org ${suffix}`,
    })
    .returning();
  return org!;
}

function makeDetail(
  n: number,
  updatedAt: string,
  state: "open" | "closed" = "open",
): GithubApiPullDetail {
  return {
    number: n,
    node_id: `PR_${n}`,
    state,
    draft: false,
    title: `pr ${n}`,
    html_url: `https://github.com/${REPO}/pull/${n}`,
    user: { id: 777, login: "hanfour" },
    base: { ref: "main" },
    additions: 1,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: updatedAt,
    merged_at: state === "closed" ? updatedAt : null,
    closed_at: state === "closed" ? updatedAt : null,
  };
}

/** GithubClient stub: only the methods syncRepoPulls touches. */
function stubClient(
  details: GithubApiPullDetail[],
  calls: string[][] = [],
): GithubClient {
  return {
    listRepoFullNames: async () => [REPO],
    listPullsSince: async (_repo, since) => {
      calls.push(["listPullsSince", String(since)]);
      return details
        .filter((d) => since === null || d.updated_at >= since)
        .map((d) => ({
          number: d.number,
          node_id: d.node_id,
          updated_at: d.updated_at,
        }));
    },
    getPull: async (_repo, n) => details.find((d) => d.number === n)!,
    listReviews: async (_repo, n) =>
      n === 1
        ? [
            {
              node_id: "R_1",
              user: { id: 5, login: "joe" },
              state: "APPROVED",
              submitted_at: "2026-07-02T00:00:00Z",
            },
          ]
        : [],
    listIssuesSince: async () => [],
    getIssue: async () => {
      throw new Error("unused");
    },
    graphql: async () => {
      throw new Error("unused");
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("syncRepoPulls", () => {
  it("first sync inserts PRs + reviews and sets the pulls watermark", async () => {
    const org = await insertOrg(db);
    const client = stubClient([
      makeDetail(1, "2026-07-02T00:00:00Z", "closed"),
      makeDetail(2, "2026-07-03T00:00:00Z"),
    ]);
    const res = await syncRepoPulls({
      db,
      client,
      orgId: org.id,
      repoFullName: REPO,
    });
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
    await syncRepoPulls({
      db,
      client: stubClient([d1], calls),
      orgId: org.id,
      repoFullName: REPO,
    });
    // PR 1 got merged later — same node_id, newer updated_at
    const d1v2 = makeDetail(1, "2026-07-05T00:00:00Z", "closed");
    await syncRepoPulls({
      db,
      client: stubClient([d1v2], calls),
      orgId: org.id,
      repoFullName: REPO,
    });

    expect(calls[1]![1]).toBe("2026-07-02T00:00:00.000Z"); // watermark forwarded
    const prs = (await db.select().from(githubPullRequests)).filter(
      (p) => p.orgId === org.id,
    );
    expect(prs).toHaveLength(1); // upserted, not duplicated
    expect(prs[0]!.state).toBe("closed");
    expect(prs[0]!.mergedAt).toEqual(new Date("2026-07-05T00:00:00Z"));
  });

  it("setWatermark upserts on conflict", async () => {
    const org = await insertOrg(db);
    await setWatermark(db, {
      orgId: org.id,
      repoFullName: REPO,
      resourceType: "pulls",
      watermark: new Date("2026-01-01T00:00:00Z"),
    });
    await setWatermark(db, {
      orgId: org.id,
      repoFullName: REPO,
      resourceType: "pulls",
      watermark: new Date("2026-02-01T00:00:00Z"),
    });
    expect(await getWatermark(db, org.id, REPO, "pulls")).toEqual(
      new Date("2026-02-01T00:00:00Z"),
    );
  });
});
