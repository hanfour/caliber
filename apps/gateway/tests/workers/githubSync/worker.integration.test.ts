/**
 * Integration tests for PR1 Task 13: `createGithubSyncWorker`.
 *
 * Real BullMQ round-trip over Postgres + Redis testcontainers (modeled on
 * apps/gateway/tests/workers/evaluator/workerRubricWiring.integration.test.ts
 * — real Redis, not ioredis-mock, since BullMQ needs a genuine connection).
 *
 * enqueueGithubSync → createGithubSyncWorker processes it → syncOrg runs for
 * real (decrypt PAT, route-fake fetch) → a row lands in github_pull_requests.
 *
 * Container + `insertOrg`/`insertConnection`/`routeFetch`/`json`/`PULL_DETAIL`
 * helpers copied from apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import { encryptCredential } from "@caliber/gateway-core";
import {
  organizations,
  githubConnections,
  githubPullRequests,
  type Database,
} from "@caliber/db";
import {
  createGithubSyncQueue,
  enqueueGithubSync,
} from "../../../src/workers/githubSync/queue.js";
import { createGithubSyncWorker } from "../../../src/workers/githubSync/worker.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const MASTER_KEY = "ab".repeat(32); // 64 hex chars
const TOKEN = "github_pat_TESTTOKEN00000000000000";

// ── Containers + shared state ────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let redisContainer: StartedRedisContainer;
let redisConnection: Redis;

beforeAll(async () => {
  [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);

  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  redisConnection = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    maxRetriesPerRequest: null,
  });
}, 180_000);

afterAll(async () => {
  await redisConnection.quit();
  await pool.end();
  await Promise.all([pgContainer.stop(), redisContainer.stop()]);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a fresh org (unique slug per call — each `it` seeds its own). */
async function insertOrg(db: Database) {
  const suffix = Math.random().toString(36).slice(2);
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `worker-test-org-${suffix}`,
      name: `Worker Test Org ${suffix}`,
    })
    .returning();
  return org!;
}

async function insertConnection(
  db: Database,
  orgId: string,
  overrides: Partial<typeof githubConnections.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const sealed = encryptCredential({
    masterKeyHex: MASTER_KEY,
    accountId: id,
    plaintext: TOKEN,
  });
  const [row] = await db
    .insert(githubConnections)
    .values({
      id,
      orgId,
      ownerLogin: "acme",
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      tokenLast4: TOKEN.slice(-4),
      ...overrides,
    })
    .returning();
  return row!;
}

/** Route-based fake fetch: dispatch on pathname, 404 otherwise. */
function routeFetch(routes: Record<string, (url: URL) => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(url);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const PULL_DETAIL = {
  number: 1,
  node_id: "PR_1",
  state: "closed",
  draft: false,
  title: "t",
  html_url: "https://github.com/acme/web/pull/1",
  user: { id: 7, login: "h" },
  base: { ref: "main" },
  additions: 1,
  deletions: 1,
  changed_files: 1,
  commits: 1,
  review_comments: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  merged_at: "2026-07-02T00:00:00Z",
  closed_at: "2026-07-02T00:00:00Z",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createGithubSyncWorker", () => {
  it("processes an enqueued job end-to-end: PAT decrypt → fetch → rows", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    const fetchImpl = routeFetch({
      "/orgs/acme/repos": () => json([{ full_name: "acme/web" }]),
      "/repos/acme/web/pulls/1/reviews": () => json([]),
      "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
      "/repos/acme/web/pulls": () =>
        json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
      "/repos/acme/web/issues": () => json([]),
      "/graphql": () =>
        json({
          data: {
            organization: {
              projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        }),
    });

    const queue = createGithubSyncQueue({ connection: redisConnection });
    const worker = createGithubSyncWorker({
      connection: redisConnection,
      db,
      masterKeyHex: MASTER_KEY,
      fetchImpl,
    });
    try {
      await enqueueGithubSync(queue, { orgId: org.id, triggeredBy: "manual" });
      // Poll until the row lands (worker is async); 15s budget.
      const deadline = Date.now() + 15_000;
      let rows: Array<{ orgId: string }> = [];
      while (Date.now() < deadline) {
        rows = (await db.select().from(githubPullRequests)).filter(
          (r) => r.orgId === org.id,
        );
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(rows).toHaveLength(1);

      // Regression (C1): BullMQ's `add` dedups against the job hash for
      // ANY jobId that still exists — including a COMPLETED job, per
      // removeOnComplete: { age: 86400, count: 500 } — and our jobId
      // (`ghsync_v1_{orgId}`) has no time component. Without
      // remove-before-add in enqueueGithubSync, this second enqueue for
      // the same org would be silently deduped and the row would never
      // reappear, hanging this poll until the 15s budget expires.
      await db
        .delete(githubPullRequests)
        .where(eq(githubPullRequests.orgId, org.id));

      await enqueueGithubSync(queue, { orgId: org.id, triggeredBy: "manual" });
      const deadline2 = Date.now() + 15_000;
      let rows2: Array<{ orgId: string }> = [];
      while (Date.now() < deadline2) {
        rows2 = (await db.select().from(githubPullRequests)).filter(
          (r) => r.orgId === org.id,
        );
        if (rows2.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(rows2).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 45_000);

  // Proves the P2 fix end-to-end: a rate-limited sync must delay THIS SAME
  // job until (roughly) GitHub's reset time and retry it, rather than
  // failing the attempt out to BullMQ's fixed exponential backoff (which
  // would exhaust all 3 attempts long before a real GitHub rate-limit
  // window clears). `rateLimitMinDelayMs` is the test seam documented on
  // `CreateGithubSyncWorkerOptions` — it lowers computeRateLimitDelayMs's
  // 30s production floor so this test observes the retry inside its
  // timeout budget instead of waiting out the real floor.
  it("rate-limited first attempt delays the job until reset, then retries and succeeds", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);

    let repoListCalls = 0;
    const resetAtSeconds = Math.floor((Date.now() + 2000) / 1000);
    const fetchImpl = routeFetch({
      "/orgs/acme/repos": () => {
        repoListCalls += 1;
        if (repoListCalls === 1) {
          return json({ message: "rate limited" }, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAtSeconds),
          });
        }
        return json([{ full_name: "acme/web" }]);
      },
      "/repos/acme/web/pulls/1/reviews": () => json([]),
      "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
      "/repos/acme/web/pulls": () =>
        json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
      "/repos/acme/web/issues": () => json([]),
      "/graphql": () =>
        json({
          data: {
            organization: {
              projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        }),
    });

    const queue = createGithubSyncQueue({ connection: redisConnection });
    const worker = createGithubSyncWorker({
      connection: redisConnection,
      db,
      masterKeyHex: MASTER_KEY,
      fetchImpl,
      rateLimitMinDelayMs: 500,
    });
    try {
      await enqueueGithubSync(queue, { orgId: org.id, triggeredBy: "manual" });
      // 30s budget: covers the ~2s rate-limit delay plus BullMQ's delayed-job
      // pickup latency and the second full sync pass.
      const deadline = Date.now() + 30_000;
      let rows: Array<{ orgId: string }> = [];
      while (Date.now() < deadline) {
        rows = (await db.select().from(githubPullRequests)).filter(
          (r) => r.orgId === org.id,
        );
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(rows).toHaveLength(1);
      expect(repoListCalls).toBeGreaterThanOrEqual(2);

      const conn = (
        await db
          .select()
          .from(githubConnections)
          .where(eq(githubConnections.orgId, org.id))
      )[0]!;
      expect(conn.status).toBe("ok");
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 45_000);
});
