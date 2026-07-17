/**
 * Integration test for the daily evaluator cron (Plan 4B Part 4, Task 4.3).
 *
 * Stands up real Postgres testcontainer + fake in-memory evaluator queue.
 * Verifies:
 *   1. No orgs with capture enabled → 0 jobs enqueued
 *   2. 1 org with capture enabled + 2 members → 2 jobs enqueued with correct
 *      yesterday/today UTC timestamps
 *   3. 2 orgs (1 capture-enabled, 1 not) → only enabled org's members get jobs
 *   4. Job dedup: running cron twice in the same UTC day doesn't double-enqueue
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import {
  organizations,
  organizationMembers,
  users,
  type Database,
} from "@caliber/db";
import {
  enqueueDailyEvaluatorJobs,
  startEvaluatorCron,
  type EnqueueDailyResult,
} from "../../../src/workers/evaluator/cron.js";
import type {
  EvaluatorJobPayload,
  QueueLike,
} from "../../../src/workers/evaluator/queue.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Fake in-memory queue ────────────────────────────────────────────────────

interface EnqueuedJob {
  payload: EvaluatorJobPayload;
  jobId: string;
}

class FakeEvaluatorQueue implements QueueLike {
  readonly jobs: EnqueuedJob[] = [];

  async add(
    _name: string,
    data: EvaluatorJobPayload,
    opts?: { jobId?: string },
  ): Promise<unknown> {
    const jobId = opts?.jobId ?? "";
    // Simulate BullMQ's jobId dedup: if jobId already exists, throw an error
    // (in real BullMQ, duplicate jobIds are rejected unless you set the override option).
    // This allows the cron to detect duplicates and count enqueueFailures.
    if (this.jobs.some((j) => j.jobId === jobId)) {
      throw new Error(`Job with ID ${jobId} already exists`);
    }
    this.jobs.push({ payload: data, jobId });
    return { id: jobId, key: jobId };
  }

  async close(): Promise<void> {
    // No-op
  }
}

// ── Containers + shared fixtures ─────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let baseOrgId: string;
let user1Id: string;
let user2Id: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed baseline org (capture disabled) + 2 users
  const [baseOrg] = await db
    .insert(organizations)
    .values({
      slug: "cron-test-base",
      name: "Cron Test Base Org",
      contentCaptureEnabled: false,
    })
    .returning();
  baseOrgId = baseOrg!.id;

  const [user1] = await db
    .insert(users)
    .values({ email: "cron-test-user1@example.com" })
    .returning();
  user1Id = user1!.id;

  const [user2] = await db
    .insert(users)
    .values({ email: "cron-test-user2@example.com" })
    .returning();
  user2Id = user2!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // Clear all org/member tables created during tests, but preserve base fixtures
  await db.execute(
    sql`DELETE FROM organization_members WHERE org_id != ${baseOrgId}`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE id != ${baseOrgId}`);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("enqueueDailyEvaluatorJobs", () => {
  it("1. no orgs with capture enabled → 0 jobs enqueued", async () => {
    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({ db, queue });

    expect(result.orgsConsidered).toBe(0);
    expect(result.membersEnumerated).toBe(0);
    expect(result.jobsEnqueued).toBe(0);
    expect(result.enqueueFailures).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it("2. 1 org with capture enabled + 2 members → 2 jobs enqueued with correct timestamps", async () => {
    // Create org with capture enabled
    const [org] = await db
      .insert(organizations)
      .values({
        slug: "cron-test-enabled",
        name: "Cron Test Enabled Org",
        contentCaptureEnabled: true,
      })
      .returning();
    const orgId = org!.id;

    // Add both users to this org
    await db.insert(organizationMembers).values([
      { orgId, userId: user1Id },
      { orgId, userId: user2Id },
    ]);

    const now = new Date(Date.UTC(2026, 3, 22, 12, 30, 0)); // 2026-04-22 12:30 UTC
    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => now,
    });

    expect(result.orgsConsidered).toBe(1);
    expect(result.membersEnumerated).toBe(2);
    expect(result.jobsEnqueued).toBe(2);
    expect(result.enqueueFailures).toBe(0);
    expect(queue.jobs).toHaveLength(2);

    // Verify timestamps: today = 2026-04-22 00:00 UTC, yesterday = 2026-04-21 00:00 UTC
    const expectedYesterdayStart = "2026-04-21T00:00:00.000Z";
    const expectedTodayEnd = "2026-04-22T00:00:00.000Z";

    for (const job of queue.jobs) {
      expect(job.payload.periodStart).toBe(expectedYesterdayStart);
      expect(job.payload.periodEnd).toBe(expectedTodayEnd);
      expect(job.payload.periodType).toBe("daily");
      expect(job.payload.triggeredBy).toBe("cron");
      expect(job.payload.triggeredByUser).toBeNull();
      expect(job.payload.orgId).toBe(orgId);
      expect([user1Id, user2Id]).toContain(job.payload.userId);
    }
  });

  it("3. 2 orgs (1 capture-enabled, 1 not) → only enabled org's members get jobs", async () => {
    // Create enabled org with 1 member
    const [enabledOrg] = await db
      .insert(organizations)
      .values({
        slug: "cron-test-enabled-2",
        name: "Cron Test Enabled Org 2",
        contentCaptureEnabled: true,
      })
      .returning();
    const enabledOrgId = enabledOrg!.id;

    // Create disabled org with 1 member (should be ignored)
    const [disabledOrg] = await db
      .insert(organizations)
      .values({
        slug: "cron-test-disabled-2",
        name: "Cron Test Disabled Org 2",
        contentCaptureEnabled: false,
      })
      .returning();
    const disabledOrgId = disabledOrg!.id;

    await db.insert(organizationMembers).values([
      { orgId: enabledOrgId, userId: user1Id },
      { orgId: disabledOrgId, userId: user2Id },
    ]);

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({ db, queue });

    expect(result.orgsConsidered).toBe(1); // Only enabled org counted
    expect(result.membersEnumerated).toBe(1);
    expect(result.jobsEnqueued).toBe(1);
    expect(queue.jobs).toHaveLength(1);

    // Verify the job is for the enabled org + user1
    const job0 = queue.jobs[0];
    expect(job0).toBeDefined();
    expect(job0!.payload.orgId).toBe(enabledOrgId);
    expect(job0!.payload.userId).toBe(user1Id);
  });

  it("4. job dedup: running cron twice same day doesn't double-enqueue", async () => {
    // Create enabled org with 1 member
    const [org] = await db
      .insert(organizations)
      .values({
        slug: "cron-test-dedup",
        name: "Cron Test Dedup Org",
        contentCaptureEnabled: true,
      })
      .returning();
    const orgId = org!.id;

    await db.insert(organizationMembers).values({ orgId, userId: user1Id });

    const now = new Date(Date.UTC(2026, 3, 22, 12, 30, 0)); // Same UTC day
    const queue = new FakeEvaluatorQueue();

    // First run
    const result1 = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => now,
    });
    expect(result1.jobsEnqueued).toBe(1);
    expect(queue.jobs).toHaveLength(1);

    // Second run (same UTC day, same jobId)
    const result2 = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => now,
    });
    // Second run encounters duplicate jobId, which the fake queue rejects as an error.
    // This gets counted as an enqueueFailure in the cron.
    expect(result2.jobsEnqueued).toBe(0);
    expect(result2.enqueueFailures).toBe(1);
    expect(queue.jobs).toHaveLength(1); // Still only 1 job
  });
});

describe("startEvaluatorCron", () => {
  it("tick joins the in-flight start-up pass instead of running a second one", async () => {
    // Seed an org with capture enabled + 2 members — one pass of
    // enqueueDailyEvaluatorJobs enqueues exactly 2 jobs.
    const [org] = await db
      .insert(organizations)
      .values({
        slug: "cron-test-tick-join",
        name: "Cron Test Tick Join Org",
        contentCaptureEnabled: true,
      })
      .returning();
    const orgId = org!.id;
    await db.insert(organizationMembers).values([
      { orgId, userId: user1Id },
      { orgId, userId: user2Id },
    ]);

    const added: unknown[] = [];
    const queue = {
      add: async (...a: unknown[]) => void added.push(a),
    };
    const noopLogger = { info: () => {}, error: () => {} };

    const handle = startEvaluatorCron({
      db,
      queue,
      logger: noopLogger,
      intervalMs: 60 * 60 * 1000, // irrelevant; we call tick() directly
    });
    // Do NOT clear `added` — the point is that the start-up tick and this
    // tick() call are ONE pass, so the enqueue count must equal a single
    // pass's worth (2 members), not double (4).
    await handle.tick();
    // NOTE: stop() only after tick() — stop() sets the stopped flag, which
    // makes runTick bail before starting a pass. Unlike githubSync/interval.ts,
    // enqueueDailyEvaluatorJobs never re-checks it, so an in-flight pass runs
    // to completion; stopping first would just enqueue nothing.
    handle.stop();

    expect(added).toHaveLength(2);
  });
});
