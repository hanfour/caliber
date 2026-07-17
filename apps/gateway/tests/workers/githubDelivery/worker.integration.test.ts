/**
 * Integration tests for PR2 Task 8 / PR3 Task 6: `createGithubDeliveryWorker`.
 *
 * Real BullMQ round-trip over Postgres + Redis testcontainers (modeled on
 * apps/gateway/tests/workers/githubSync/worker.integration.test.ts — real
 * Redis, not ioredis-mock, since BullMQ needs a genuine connection).
 *
 * enqueueGithubDelivery → createGithubDeliveryWorker processes it →
 * runDeliveryEval runs for real (fresh `lastSyncAt` → sync skipped, scores
 * existing activity rows) → a row lands in github_delivery_reports. The org
 * seeded here is llm_eval_enabled=false (default), so PR3's quality layer
 * fast-skips ("disabled") — this test proves dark-path parity: threading
 * the new required `redis`/`gatewayBaseUrl` options through the worker
 * doesn't change the e2e result for orgs that haven't opted into LLM eval.
 *
 * Container + `insertOrg`/`insertConnection` helpers copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts;
 * `insertMember` copied from
 * apps/gateway/tests/workers/githubDelivery/fetchActivity.integration.test.ts;
 * activity seed shape (1 merged PR + 2 reviews on other authors' PRs, to
 * clear DELIVERY_MIN_EVENTS=3) copied from Task 7's
 * runDeliveryEval.integration.test.ts.
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
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { encryptCredential } from "@caliber/gateway-core";
import {
  organizations,
  githubConnections,
  githubPullRequests,
  githubReviews,
  githubDeliveryReports,
  accounts,
  users,
  type Database,
} from "@caliber/db";
import {
  createGithubDeliveryQueue,
  enqueueGithubDelivery,
} from "../../../src/workers/githubDelivery/queue.js";
import { createGithubDeliveryWorker } from "../../../src/workers/githubDelivery/worker.js";

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
      slug: `delivery-worker-test-org-${suffix}`,
      name: `Delivery Worker Test Org ${suffix}`,
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

describe("createGithubDeliveryWorker", () => {
  it("processes an enqueued delivery job end-to-end into github_delivery_reports", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id, { lastSyncAt: new Date() }); // fresh → no sync, no fetch
    const member = await insertMember(db, 777);

    // seed activity rows clearing DELIVERY_MIN_EVENTS=3 (1 merged PR by the
    // member + 2 reviews by the member on other authors' PRs — shapes from
    // Task 7's runDeliveryEval.integration.test.ts).
    await db.insert(githubPullRequests).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 1,
        ghNodeId: "PR_1",
        authorGhId: 777,
        authorLogin: "me",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-06-20T00:00:00Z"),
        mergedAt: new Date("2026-06-21T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 2,
        ghNodeId: "PR_2",
        authorGhId: 889,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-06-20T00:00:00Z"),
        mergedAt: new Date("2026-06-21T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 3,
        ghNodeId: "PR_3",
        authorGhId: 889,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-06-20T00:00:00Z"),
        mergedAt: new Date("2026-06-21T00:00:00Z"),
      },
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
        submittedAt: new Date("2026-06-22T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_2",
        prGhNodeId: "PR_3",
        reviewerGhId: 777,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-06-22T00:00:00Z"),
      },
    ]);

    const queue = createGithubDeliveryQueue({ connection: redisConnection });
    // `redis`/`gatewayBaseUrl` are REQUIRED as of PR3 Task 6 (threaded to
    // runDeliveryEval's LLM quality layer). ioredis-mock + a dummy base URL
    // are enough here — the seeded org is llm_eval_enabled=false (default),
    // so the quality layer never reaches redis/fetch (see file header).
    const worker = createGithubDeliveryWorker({
      connection: redisConnection,
      db,
      masterKeyHex: MASTER_KEY,
      redis: new RedisMock() as unknown as Redis,
      gatewayBaseUrl: "http://localhost:3002",
    });
    try {
      await enqueueGithubDelivery(queue, {
        orgId: org.id,
        userId: member.id,
        periodStart: "2026-06-16T00:00:00.000Z",
        periodEnd: "2026-07-16T00:00:00.000Z",
        periodType: "daily",
        triggeredBy: "manual",
      });
      const deadline = Date.now() + 15_000;
      let rows: Array<{ userId: string }> = [];
      while (Date.now() < deadline) {
        rows = (await db.select().from(githubDeliveryReports)).filter((r) => r.userId === member.id);
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(rows).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 45_000);
});
