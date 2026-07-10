/**
 * Real-BullMQ regression test for the evaluator enqueue colon-jobId fix.
 *
 * BullMQ 5.75.2 throws `Custom Id cannot contain :` when a custom jobId
 * satisfies `jobId.includes(':') && jobId.split(':').length !== 3`. The old
 * inline jobId embedded an ISO periodStart (multiple colons), which triggered
 * this error on every real enqueue attempt. This test stands up a real Redis
 * testcontainer (not a mock) to verify that `enqueueEvaluator` no longer
 * throws and returns a colon-free jobId for BOTH the per-person and per-key
 * payloads.
 *
 * The existing unit tests in evaluatorQueue.test.ts use a mock queue and
 * never exercise BullMQ's id validation — this integration test closes that gap.
 *
 * Also verifies the lockstep property: the jobId returned by `enqueueEvaluator`
 * equals `buildEvaluatorJobId` called directly with the same inputs (ensuring
 * the reports.ts rerun side would dedup correctly against the cron side).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import {
  enqueueEvaluator,
  createEvaluatorQueue,
  EVALUATOR_QUEUE_NAME,
  EVALUATOR_QUEUE_PREFIX,
} from "../../../src/workers/evaluator/queue.js";
import { buildEvaluatorJobId } from "@caliber/evaluator";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const API_KEY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// ISO datetime with multiple colons — this was the root cause
const PERIOD_START = "2026-06-30T00:00:00.000Z";
const PERIOD_END = "2026-06-30T23:59:59.999Z";

// ── Container lifecycle ───────────────────────────────────────────────────────

let redisContainer: StartedRedisContainer;
let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  redisContainer = await new RedisContainer("redis:7-alpine").start();
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);

  redis = new Redis(redisPort, redisHost, { maxRetriesPerRequest: null });
  queue = createEvaluatorQueue({
    connection: { host: redisHost, port: redisPort },
    // Use a test-specific prefix to avoid colliding with other tests
    prefix: "test:evaluator-colon-fix",
  });
});

afterAll(async () => {
  await queue.close();
  await redis.quit();
  await redisContainer.stop();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueueEvaluator — real BullMQ (colon-jobId regression)", () => {
  it("per-person payload: does NOT throw and returns a colon-free jobId", async () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "daily" as const,
      triggeredBy: "cron" as const,
      triggeredByUser: null,
    };

    // This would throw `Custom Id cannot contain :` before the fix
    const result = await enqueueEvaluator(queue, payload);

    expect(result.jobId).toBeDefined();
    expect(result.jobId).not.toContain(":");
    expect(result.jobId).toContain(USER_ID);
    expect(result.jobId).toContain("daily");
  });

  it("per-key payload: does NOT throw and returns a colon-free jobId", async () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      keyNameSnapshot: "My Test Key",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "daily" as const,
      triggeredBy: "cron" as const,
      triggeredByUser: null,
    };

    // This would throw `Custom Id cannot contain :` before the fix
    const result = await enqueueEvaluator(queue, payload);

    expect(result.jobId).toBeDefined();
    expect(result.jobId).not.toContain(":");
    expect(result.jobId).toContain(USER_ID);
    expect(result.jobId).toContain(API_KEY_ID);
    expect(result.jobId).toContain("daily");
  });

  it("per-person and per-key jobIds differ for the same userId + period", async () => {
    const base = {
      orgId: ORG_ID,
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "weekly" as const,
      triggeredBy: "admin_rerun" as const,
      triggeredByUser: null,
    };

    const perPersonResult = await enqueueEvaluator(queue, base);
    const perKeyResult = await enqueueEvaluator(queue, {
      ...base,
      apiKeyId: API_KEY_ID,
      keyNameSnapshot: "Some Key",
    });

    expect(perPersonResult.jobId).not.toBe(perKeyResult.jobId);
  });

  it("lockstep: enqueueEvaluator jobId equals buildEvaluatorJobId for per-person inputs", async () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "daily" as const,
      triggeredBy: "cron" as const,
      triggeredByUser: null,
    };

    const enqueueResult = await enqueueEvaluator(queue, payload);
    // Simulate what reports.ts rerun calls (buildEvaluatorJobId directly)
    const rerunJobId = buildEvaluatorJobId({
      orgId: ORG_ID,
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: "daily",
    });

    expect(enqueueResult.jobId).toBe(rerunJobId);
  });

  it("lockstep: enqueueEvaluator jobId equals buildEvaluatorJobId for per-key inputs", async () => {
    const payload = {
      orgId: ORG_ID,
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      keyNameSnapshot: "Lockstep Test Key",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "daily" as const,
      triggeredBy: "cron" as const,
      triggeredByUser: null,
    };

    const enqueueResult = await enqueueEvaluator(queue, payload);
    // Simulate what reports.ts rerun calls (buildEvaluatorJobId directly)
    const rerunJobId = buildEvaluatorJobId({
      orgId: ORG_ID,
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      periodStart: PERIOD_START,
      periodType: "daily",
    });

    expect(enqueueResult.jobId).toBe(rerunJobId);
  });
});
