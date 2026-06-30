/**
 * Integration tests for Task 4: per-key cron fan-out (PR4).
 *
 * Covers:
 *   (a) jobId is 3-part when apiKeyId absent (byte-identical to existing
 *       format) and 4-part when set; per-key and per-person jobIds NEVER
 *       collide for the same userId + periodStart + periodType.
 *   (b) with enableProjectEvaluation=true, cron enqueues one job per
 *       opted-in key WITH traffic in the window; idle, revoked, and
 *       non-opted keys are skipped.
 *   (c) per-user cap (maxProjectKeysPerUser) caps fan-out at N keys per
 *       user per org, incrementing keyJobsCapped for the over-cap keys.
 *   (d) flag off (enableProjectEvaluation=false / omitted) → zero per-key
 *       jobs enqueued; per-person jobsEnqueued / enqueueFailures counts
 *       are byte-identical to the pre-PR4 baseline.
 *   (e) EvaluatorJobPayload Zod refine: apiKeyId present requires a
 *       non-empty keyNameSnapshot; absent apiKeyId is always valid.
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
  apiKeys,
  organizations,
  organizationMembers,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import type { JobsOptions } from "bullmq";
import {
  EvaluatorJobPayload,
  enqueueEvaluator,
  type QueueLike,
} from "../../../src/workers/evaluator/queue.js";
import {
  enqueueDailyEvaluatorJobs,
} from "../../../src/workers/evaluator/cron.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Fixed UUIDs for collision-safety proofs ──────────────────────────────────

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERIOD_START = "2026-06-30T00:00:00.000Z";
const PERIOD_TYPE = "daily" as const;

// ── Fake in-memory queue ─────────────────────────────────────────────────────

interface EnqueuedJob {
  payload: EvaluatorJobPayload;
  jobId: string;
}

class FakeEvaluatorQueue implements QueueLike {
  readonly jobs: EnqueuedJob[] = [];

  async add(
    _name: string,
    data: EvaluatorJobPayload,
    opts?: JobsOptions,
  ): Promise<unknown> {
    const jobId = (opts as { jobId?: string } | undefined)?.jobId ?? "";
    if (this.jobs.some((j) => j.jobId === jobId)) {
      throw new Error(`Job with ID ${jobId} already exists`);
    }
    this.jobs.push({ payload: data, jobId });
    return { id: jobId, key: jobId };
  }

  async close(): Promise<void> {}
}

// ── (a) jobId format + collision safety ─────────────────────────────────────

describe("(a) enqueueEvaluator — jobId collision safety", () => {
  const ORG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const PERIOD_END = "2026-07-01T00:00:00.000Z";

  function makeQueue() {
    const calls: Array<{ jobId: string }> = [];
    const queue: QueueLike = {
      add: async (_name, _data, opts) => {
        calls.push({ jobId: (opts as { jobId?: string } | undefined)?.jobId ?? "" });
        return {};
      },
    };
    return { queue, calls };
  }

  it("per-person payload (no apiKeyId) → 3-part jobId: userId:periodStart:periodType", async () => {
    const { queue, calls } = makeQueue();
    await enqueueEvaluator(queue, {
      orgId: ORG_ID,
      userId: USER_A,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: PERIOD_TYPE,
      triggeredBy: "cron",
      triggeredByUser: null,
      // apiKeyId intentionally absent
    });
    const expected = `${USER_A}:${PERIOD_START}:${PERIOD_TYPE}`;
    expect(calls[0]!.jobId).toBe(expected);
  });

  it("per-key payload (apiKeyId set) → 4-part jobId: userId:apiKeyId:periodStart:periodType", async () => {
    const { queue, calls } = makeQueue();
    await enqueueEvaluator(queue, {
      orgId: ORG_ID,
      userId: USER_A,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: PERIOD_TYPE,
      triggeredBy: "cron",
      triggeredByUser: null,
      apiKeyId: KEY_A,
      keyNameSnapshot: "my-project-key",
    });
    const expected = `${USER_A}:${KEY_A}:${PERIOD_START}:${PERIOD_TYPE}`;
    expect(calls[0]!.jobId).toBe(expected);
  });

  it("per-person and per-key jobIds for same userId+period NEVER collide", async () => {
    const { queue: q1, calls: c1 } = makeQueue();
    const { queue: q2, calls: c2 } = makeQueue();

    await enqueueEvaluator(q1, {
      orgId: ORG_ID,
      userId: USER_A,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: PERIOD_TYPE,
      triggeredBy: "cron",
      triggeredByUser: null,
    });

    await enqueueEvaluator(q2, {
      orgId: ORG_ID,
      userId: USER_A,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: PERIOD_TYPE,
      triggeredBy: "cron",
      triggeredByUser: null,
      apiKeyId: KEY_A,
      keyNameSnapshot: "my-project-key",
    });

    const personJobId = c1[0]!.jobId;
    const keyJobId = c2[0]!.jobId;

    expect(personJobId).not.toBe(keyJobId);
    // 3-part has 2 separator colons less than 4-part (which adds apiKeyId between userId and periodStart)
    // Verify structural difference: 4-part starts with userId:apiKeyId:, 3-part starts with userId:periodStart
    expect(keyJobId.startsWith(`${USER_A}:${KEY_A}:`)).toBe(true);
    expect(personJobId.startsWith(`${USER_A}:${KEY_A}:`)).toBe(false);
  });

  it("3-part format is byte-identical to pre-PR4 format (no apiKeyId → unchanged)", async () => {
    const { queue, calls } = makeQueue();
    await enqueueEvaluator(queue, {
      orgId: ORG_ID,
      userId: USER_A,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: PERIOD_TYPE,
      triggeredBy: "cron",
      triggeredByUser: null,
    });
    // Must match the exact pre-PR4 format
    expect(calls[0]!.jobId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2026-06-30T00:00:00.000Z:daily",
    );
  });
});

// ── (e) EvaluatorJobPayload Zod refine ──────────────────────────────────────

describe("(e) EvaluatorJobPayload — co-presence refine", () => {
  const ORG_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const PERIOD_END = "2026-07-01T00:00:00.000Z";

  const base = {
    orgId: ORG_ID,
    userId: USER_A,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    periodType: "daily" as const,
    triggeredBy: "cron" as const,
    triggeredByUser: null,
  };

  it("apiKeyId absent + keyNameSnapshot absent → valid (per-person path)", () => {
    const result = EvaluatorJobPayload.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("apiKeyId set + keyNameSnapshot present (non-empty) → valid", () => {
    const result = EvaluatorJobPayload.safeParse({
      ...base,
      apiKeyId: KEY_A,
      keyNameSnapshot: "my-project-key",
    });
    expect(result.success).toBe(true);
  });

  it("apiKeyId set + keyNameSnapshot absent → invalid (refine fails)", () => {
    const result = EvaluatorJobPayload.safeParse({
      ...base,
      apiKeyId: KEY_A,
      // keyNameSnapshot intentionally omitted
    });
    expect(result.success).toBe(false);
  });

  it("apiKeyId set + keyNameSnapshot empty string → invalid (refine fails)", () => {
    const result = EvaluatorJobPayload.safeParse({
      ...base,
      apiKeyId: KEY_A,
      keyNameSnapshot: "",
    });
    expect(result.success).toBe(false);
  });

  it("apiKeyId absent + keyNameSnapshot absent → valid even with no snapshot", () => {
    const result = EvaluatorJobPayload.safeParse({ ...base });
    expect(result.success).toBe(true);
  });
});

// ── Integration: testcontainer setup ────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

// Shared fixtures created in beforeAll
let captureOrgId: string;
let userId1: string;
let userId2: string;
let accountId: string;

// Yesterday / today window (UTC)
const NOW = new Date(Date.UTC(2026, 5, 30, 12, 0, 0)); // 2026-06-30 12:00 UTC
const TODAY_00 = new Date(Date.UTC(2026, 5, 30, 0, 0, 0));
const YESTERDAY_00 = new Date(Date.UTC(2026, 5, 29, 0, 0, 0));
// A timestamp inside the window
const IN_WINDOW = new Date(Date.UTC(2026, 5, 29, 8, 0, 0)); // 2026-06-29 08:00 UTC
// A timestamp outside the window (too old)
const BEFORE_WINDOW = new Date(Date.UTC(2026, 5, 27, 0, 0, 0));

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed org with capture enabled
  const [captureOrg] = await db
    .insert(organizations)
    .values({
      slug: "per-key-cron-test-org",
      name: "Per Key Cron Test Org",
      contentCaptureEnabled: true,
    })
    .returning();
  captureOrgId = captureOrg!.id;

  // Seed two users
  const [u1] = await db
    .insert(users)
    .values({ email: "pkcron-user1@example.com" })
    .returning();
  userId1 = u1!.id;

  const [u2] = await db
    .insert(users)
    .values({ email: "pkcron-user2@example.com" })
    .returning();
  userId2 = u2!.id;

  // Add both users to the org
  await db.insert(organizationMembers).values([
    { orgId: captureOrgId, userId: userId1 },
    { orgId: captureOrgId, userId: userId2 },
  ]);

  // Seed upstream account (FK needed by usage_logs)
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId: captureOrgId,
      name: "pkcron-test-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  // Clear api_keys and usage_logs between tests
  await db.execute(sql`DELETE FROM usage_logs`);
  await db.execute(sql`DELETE FROM api_keys WHERE org_id = ${captureOrgId}`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

let _keySeq = 0;
async function seedKey(opts: {
  userId: string;
  evaluateAsProject: boolean;
  revokedAt?: Date | null;
  name?: string;
}): Promise<string> {
  _keySeq += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: captureOrgId,
      keyHash: `hash-pkcron-${_keySeq}-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "pkcr-",
      name: opts.name ?? `test-key-${_keySeq}`,
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
      evaluateAsProject: opts.evaluateAsProject,
      revokedAt: opts.revokedAt ?? null,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

let _reqSeq = 0;
async function seedUsageLog(apiKeyId: string, createdAt: Date): Promise<void> {
  _reqSeq += 1;
  await db.insert(usageLogs).values({
    requestId: `pkcron-req-${_reqSeq}-${Math.random().toString(36).slice(2)}`,
    userId: userId1,
    apiKeyId,
    accountId,
    orgId: captureOrgId,
    requestedModel: "claude-haiku-4-5",
    upstreamModel: "claude-haiku-4-5-20251001",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    statusCode: 200,
    durationMs: 500,
    inputTokens: 100,
    outputTokens: 50,
    createdAt,
  });
}

// ── (b) Opts-in × traffic enumeration ────────────────────────────────────────

describe("(b) enqueueDailyEvaluatorJobs — per-key enumeration", () => {
  it("opted-in key WITH traffic → 1 per-key job; idle/revoked/non-opted keys → 0", async () => {
    const optedInWithTraffic = await seedKey({ userId: userId1, evaluateAsProject: true, name: "opted-in-traffic" });
    const optedInNoTraffic = await seedKey({ userId: userId1, evaluateAsProject: true, name: "opted-in-idle" });
    const notOpted = await seedKey({ userId: userId1, evaluateAsProject: false, name: "not-opted" });
    const revokedOpted = await seedKey({ userId: userId1, evaluateAsProject: true, revokedAt: new Date("2026-06-01"), name: "revoked-opted" });

    // Only optedInWithTraffic gets traffic in the window
    await seedUsageLog(optedInWithTraffic, IN_WINDOW);
    // optedInNoTraffic gets traffic outside the window
    await seedUsageLog(optedInNoTraffic, BEFORE_WINDOW);
    // notOpted gets traffic (but is not opted in)
    await seedUsageLog(notOpted, IN_WINDOW);
    // revokedOpted gets traffic (but is revoked)
    await seedUsageLog(revokedOpted, IN_WINDOW);

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
      maxProjectKeysPerUser: 20,
    });

    // Per-key pass
    expect(result.keyCandidates).toBe(1); // only optedInWithTraffic qualifies
    expect(result.keyJobsEnqueued).toBe(1);
    expect(result.keyJobsCapped).toBe(0);

    // Verify the per-key job has the right shape
    const keyJobs = queue.jobs.filter((j) => j.payload.apiKeyId !== undefined);
    expect(keyJobs).toHaveLength(1);
    expect(keyJobs[0]!.payload.apiKeyId).toBe(optedInWithTraffic);
    expect(keyJobs[0]!.payload.keyNameSnapshot).toBe("opted-in-traffic");
    expect(keyJobs[0]!.payload.triggeredBy).toBe("cron");
    expect(keyJobs[0]!.payload.orgId).toBe(captureOrgId);
    expect(keyJobs[0]!.payload.userId).toBe(userId1);
    expect(keyJobs[0]!.payload.periodStart).toBe(YESTERDAY_00.toISOString());
    expect(keyJobs[0]!.payload.periodEnd).toBe(TODAY_00.toISOString());
    expect(keyJobs[0]!.payload.periodType).toBe("daily");

    // jobId is 4-part
    const expectedKeyJobId = `${userId1}:${optedInWithTraffic}:${YESTERDAY_00.toISOString()}:daily`;
    expect(keyJobs[0]!.jobId).toBe(expectedKeyJobId);
  });

  it("traffic at window boundary: exactly at yesterday00 is included, exactly at today00 is excluded", async () => {
    const keyAtStart = await seedKey({ userId: userId1, evaluateAsProject: true, name: "at-start" });
    const keyAtEnd = await seedKey({ userId: userId1, evaluateAsProject: true, name: "at-end" });

    await seedUsageLog(keyAtStart, YESTERDAY_00); // >= yesterday00 → included
    await seedUsageLog(keyAtEnd, TODAY_00); // >= today00 → excluded

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
    });

    expect(result.keyCandidates).toBe(1);
    expect(result.keyJobsEnqueued).toBe(1);
    const keyJobs = queue.jobs.filter((j) => j.payload.apiKeyId !== undefined);
    expect(keyJobs[0]!.payload.apiKeyId).toBe(keyAtStart);
  });

  it("per-key jobs have 4-part jobIds that never collide with per-person 3-part jobIds", async () => {
    const optedKey = await seedKey({ userId: userId1, evaluateAsProject: true, name: "collision-check" });
    await seedUsageLog(optedKey, IN_WINDOW);

    const queue = new FakeEvaluatorQueue();
    await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
    });

    const personJobs = queue.jobs.filter((j) => j.payload.apiKeyId === undefined);
    const keyJobs = queue.jobs.filter((j) => j.payload.apiKeyId !== undefined);

    // Both user1 and user2 get person jobs (2 members)
    expect(personJobs.length).toBeGreaterThanOrEqual(1);
    // 1 per-key job
    expect(keyJobs).toHaveLength(1);

    // No jobId should appear in both lists
    const personJobIds = new Set(personJobs.map((j) => j.jobId));
    const keyJobIds = new Set(keyJobs.map((j) => j.jobId));
    for (const kid of keyJobIds) {
      expect(personJobIds.has(kid)).toBe(false);
    }
  });
});

// ── (c) Per-user cap ─────────────────────────────────────────────────────────

describe("(c) per-user cap — keyJobsCapped", () => {
  it("3 opted-in keys with traffic + cap=2 → 2 enqueued, 1 capped", async () => {
    const keyA = await seedKey({ userId: userId1, evaluateAsProject: true, name: "cap-key-a" });
    const keyB = await seedKey({ userId: userId1, evaluateAsProject: true, name: "cap-key-b" });
    const keyC = await seedKey({ userId: userId1, evaluateAsProject: true, name: "cap-key-c" });

    await seedUsageLog(keyA, IN_WINDOW);
    await seedUsageLog(keyB, IN_WINDOW);
    await seedUsageLog(keyC, IN_WINDOW);

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
      maxProjectKeysPerUser: 2,
    });

    expect(result.keyCandidates).toBe(3);
    expect(result.keyJobsEnqueued).toBe(2);
    expect(result.keyJobsCapped).toBe(1);

    const keyJobs = queue.jobs.filter((j) => j.payload.apiKeyId !== undefined);
    expect(keyJobs).toHaveLength(2);
  });

  it("cap=0 → all per-key jobs capped, none enqueued", async () => {
    const keyA = await seedKey({ userId: userId1, evaluateAsProject: true, name: "cap0-key" });
    await seedUsageLog(keyA, IN_WINDOW);

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
      maxProjectKeysPerUser: 0,
    });

    expect(result.keyCandidates).toBe(1);
    expect(result.keyJobsEnqueued).toBe(0);
    expect(result.keyJobsCapped).toBe(1);
  });

  it("cap applies per-user: user1 capped at 1, user2 still enqueues independently", async () => {
    // user1 has 2 opted-in keys with traffic → capped at 1
    const u1key1 = await seedKey({ userId: userId1, evaluateAsProject: true, name: "u1-key1" });
    const u1key2 = await seedKey({ userId: userId1, evaluateAsProject: true, name: "u1-key2" });
    // user2 has 1 opted-in key with traffic → not capped
    const u2key1 = await seedKey({ userId: userId2, evaluateAsProject: true, name: "u2-key1" });

    await seedUsageLog(u1key1, IN_WINDOW);
    await seedUsageLog(u1key2, IN_WINDOW);
    await seedUsageLog(u2key1, IN_WINDOW);

    // Override seedUsageLog userId for u2key1 (it always inserts userId1 - need to fix for u2key1)
    // Actually, seedUsageLog always uses userId1; usage_logs.user_id just needs to be a valid user FK.
    // The EXISTS subquery only checks api_key_id, not user_id, so this is fine.

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      enableProjectEvaluation: true,
      maxProjectKeysPerUser: 1,
    });

    expect(result.keyCandidates).toBe(3);
    expect(result.keyJobsEnqueued).toBe(2); // 1 for user1 + 1 for user2
    expect(result.keyJobsCapped).toBe(1); // 1 from user1 over-cap
  });
});

// ── (d) Flag off ─────────────────────────────────────────────────────────────

describe("(d) enableProjectEvaluation=false → zero per-key jobs", () => {
  it("flag omitted → keyCandidates/keyJobsEnqueued/keyJobsCapped all 0", async () => {
    const optedKey = await seedKey({ userId: userId1, evaluateAsProject: true, name: "flag-off-key" });
    await seedUsageLog(optedKey, IN_WINDOW);

    const queue = new FakeEvaluatorQueue();
    const result = await enqueueDailyEvaluatorJobs({
      db,
      queue,
      now: () => NOW,
      // enableProjectEvaluation intentionally omitted (defaults to false)
    });

    expect(result.keyCandidates).toBe(0);
    expect(result.keyJobsEnqueued).toBe(0);
    expect(result.keyJobsCapped).toBe(0);

    // Per-person pass still runs (2 members → 2 jobs)
    const personJobs = queue.jobs.filter((j) => j.payload.apiKeyId === undefined);
    expect(personJobs).toHaveLength(2);
  });

  it("flag=false → same per-person counts as without per-key pass", async () => {
    const optedKey = await seedKey({ userId: userId1, evaluateAsProject: true, name: "flag-false-key" });
    await seedUsageLog(optedKey, IN_WINDOW);

    const q1 = new FakeEvaluatorQueue();
    const resultOff = await enqueueDailyEvaluatorJobs({
      db,
      queue: q1,
      now: () => NOW,
      enableProjectEvaluation: false,
    });

    const q2 = new FakeEvaluatorQueue();
    const resultOn = await enqueueDailyEvaluatorJobs({
      db,
      queue: q2,
      now: () => NOW,
      enableProjectEvaluation: true,
    });

    // Per-person counts identical
    expect(resultOff.orgsConsidered).toBe(resultOn.orgsConsidered);
    expect(resultOff.membersEnumerated).toBe(resultOn.membersEnumerated);
    expect(resultOff.jobsEnqueued).toBe(resultOn.jobsEnqueued);
    expect(resultOff.enqueueFailures).toBe(resultOn.enqueueFailures);

    // Per-key counts differ
    expect(resultOff.keyJobsEnqueued).toBe(0);
    expect(resultOn.keyJobsEnqueued).toBe(1);
  });
});
