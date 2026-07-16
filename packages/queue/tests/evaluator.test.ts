/**
 * Unit tests for the evaluator queue + enqueue wrapper (Plan 4B Part 4, Task 4.1).
 *
 * Uses a fake queue (no Redis). Covers:
 *   1. Rejects invalid payload (missing orgId)
 *   2. Rejects invalid payload (non-uuid userId)
 *   3. Rejects invalid periodType value
 *   4. jobId is colon-free and encodes orgId + userId + periodStart + periodType (via buildEvaluatorJobId)
 *   5. Uses job name `evaluator`
 *   6. Applies default job options correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobsOptions } from "bullmq";
import {
  enqueueEvaluator,
  EvaluatorJobPayload,
  EVALUATOR_JOB_NAME,
  EVALUATOR_QUEUE_NAME,
  EVALUATOR_QUEUE_PREFIX,
  EVALUATOR_DEFAULT_JOB_OPTIONS,
  buildQueueOptions,
  type QueueLike,
} from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALID_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VALID_PERIOD_START = "2024-01-01T00:00:00Z";
const VALID_PERIOD_END = "2024-01-31T23:59:59Z";

function validPayload(
  overrides: Partial<EvaluatorJobPayload> = {},
): EvaluatorJobPayload {
  return {
    orgId: VALID_ORG_ID,
    userId: VALID_USER_ID,
    periodStart: VALID_PERIOD_START,
    periodEnd: VALID_PERIOD_END,
    periodType: "daily",
    triggeredBy: "cron",
    triggeredByUser: null,
    ...overrides,
  };
}

interface RecordedAdd {
  name: string;
  data: EvaluatorJobPayload;
  opts: JobsOptions | undefined;
}

function makeFakeQueue(): {
  queue: QueueLike;
  calls: RecordedAdd[];
  add: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedAdd[] = [];
  const add = vi.fn(
    async (name: string, data: EvaluatorJobPayload, opts?: JobsOptions) => {
      calls.push({ name, data, opts });
      return { id: "stub-job-id" };
    },
  );
  return { queue: { add }, calls, add };
}

const STUB_CONNECTION = { host: "localhost", port: 6379 } as const;

// ── Constants tests ──────────────────────────────────────────────────────────

describe("evaluatorQueue constants", () => {
  it("exports the design-doc queue identifier as prefix + name", () => {
    expect(`${EVALUATOR_QUEUE_PREFIX}:${EVALUATOR_QUEUE_NAME}`).toBe(
      "caliber:gw:evaluator",
    );
  });

  it("default job options enforce attempts=3 + exponential 1000ms backoff", () => {
    expect(EVALUATOR_DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(EVALUATOR_DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("default job options retain failed jobs for 7 days, completed for 24h/500", () => {
    expect(EVALUATOR_DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 86400,
      count: 500,
    });
    expect(EVALUATOR_DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 7 * 86400,
    });
  });
});

// ── buildQueueOptions tests ──────────────────────────────────────────────────

describe("buildQueueOptions", () => {
  it("uses EVALUATOR_QUEUE_PREFIX when no override supplied", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.prefix).toBe(EVALUATOR_QUEUE_PREFIX);
  });

  it("honours an explicit prefix override", () => {
    const built = buildQueueOptions({
      connection: STUB_CONNECTION,
      prefix: "test:gw",
    });
    expect(built.prefix).toBe("test:gw");
  });

  it("deep-copies the backoff object so mutation cannot bleed into the constant", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.defaultJobOptions.backoff).not.toBe(
      EVALUATOR_DEFAULT_JOB_OPTIONS.backoff,
    );
    (built.defaultJobOptions.backoff as { delay: number }).delay = 9999;
    expect(EVALUATOR_DEFAULT_JOB_OPTIONS.backoff.delay).toBe(1000);
  });

  it("merges caller-supplied defaultJobOptions over module defaults", () => {
    const built = buildQueueOptions({
      connection: STUB_CONNECTION,
      defaultJobOptions: { attempts: 5 },
    });
    expect(built.defaultJobOptions.attempts).toBe(5);
    // backoff from module default should still be present
    expect(built.defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });
});

// ── enqueueEvaluator tests ───────────────────────────────────────────────────

describe("enqueueEvaluator", () => {
  let fake: ReturnType<typeof makeFakeQueue>;

  beforeEach(() => {
    fake = makeFakeQueue();
  });

  // Test case 1: Rejects invalid payload (missing orgId)
  it("rejects invalid payload when orgId is missing", async () => {
    const incomplete = {
      userId: VALID_USER_ID,
      periodStart: VALID_PERIOD_START,
      periodEnd: VALID_PERIOD_END,
      periodType: "daily",
      triggeredBy: "cron",
      triggeredByUser: null,
      // orgId intentionally omitted
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, incomplete)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  // Test case 2: Rejects invalid payload (non-uuid userId)
  it("rejects invalid payload when userId is not a UUID", async () => {
    const bad = {
      ...validPayload(),
      userId: "not-a-uuid",
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  // Test case 3: Rejects invalid periodType value
  it("rejects invalid payload when periodType is not an enum value", async () => {
    const bad = {
      ...validPayload(),
      periodType: "invalid-period",
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  // Test case 4: jobId is colon-free and derived via buildEvaluatorJobId
  it("uses a colon-free jobId encoding orgId + userId + periodStart + periodType for dedup", async () => {
    const payload = validPayload({
      orgId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      periodStart: "2024-03-01T00:00:00Z",
      periodType: "weekly",
    });
    await enqueueEvaluator(fake.queue, payload);

    expect(fake.calls).toHaveLength(1);
    const jobId = fake.calls[0]!.opts?.jobId;
    expect(jobId).toBeDefined();
    // Must be colon-free (BullMQ 5.x rejects ids where includes(':') && split(':').length !== 3)
    expect(jobId).not.toContain(":");
    // Must contain the identity components
    expect(jobId).toContain("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(jobId).toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(jobId).toContain("weekly");
  });

  it("does not dedup per-person jobs for the same user and period in different orgs", async () => {
    const base = {
      userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      periodStart: "2024-03-01T00:00:00Z",
      periodType: "weekly" as const,
    };
    const first = await enqueueEvaluator(fake.queue, validPayload({
      ...base,
      orgId: "11111111-1111-4111-8111-111111111111",
    }));
    const second = await enqueueEvaluator(fake.queue, validPayload({
      ...base,
      orgId: "22222222-2222-4222-8222-222222222222",
    }));

    expect(first.jobId).not.toBe(second.jobId);
    expect(first.jobId).toContain("11111111-1111-4111-8111-111111111111");
    expect(second.jobId).toContain("22222222-2222-4222-8222-222222222222");
  });

  // Test case 5: Uses job name `evaluator`
  it("uses job name 'evaluator'", async () => {
    await enqueueEvaluator(fake.queue, validPayload());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.name).toBe(EVALUATOR_JOB_NAME);
    expect(fake.calls[0]!.name).toBe("evaluator");
  });

  // Test case 6: Applies default job options correctly
  it("applies default job options from the queue", async () => {
    await enqueueEvaluator(fake.queue, validPayload());

    expect(fake.calls).toHaveLength(1);
    // The options passed to queue.add should include the jobId
    expect(fake.calls[0]!.opts).toBeDefined();
    expect(fake.calls[0]!.opts).toHaveProperty("jobId");
  });

  it("returns { jobId } on happy path (colon-free)", async () => {
    const payload = validPayload({
      userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      periodStart: "2024-02-15T00:00:00Z",
      periodType: "monthly",
    });
    const result = await enqueueEvaluator(fake.queue, payload);

    expect(result.jobId).toBeDefined();
    expect(result.jobId).not.toContain(":");
    expect(result.jobId).toContain("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(result.jobId).toContain("monthly");
  });

  it("rejects invalid payload when orgId is not a UUID", async () => {
    const bad = {
      ...validPayload(),
      orgId: "not-a-uuid",
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects invalid payload when periodStart is not a valid ISO datetime", async () => {
    const bad = {
      ...validPayload(),
      periodStart: "not-a-datetime",
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects invalid payload when triggeredByUser is not a UUID when provided", async () => {
    const bad = {
      ...validPayload(),
      triggeredByUser: "not-a-uuid",
    } as unknown;

    await expect(enqueueEvaluator(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("accepts triggeredByUser=null", async () => {
    const payload = validPayload({ triggeredByUser: null });
    const result = await enqueueEvaluator(fake.queue, payload);

    expect(result).toBeDefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.data.triggeredByUser).toBeNull();
  });

  it("accepts triggeredByUser with a valid UUID", async () => {
    const payload = validPayload({
      triggeredByUser: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const result = await enqueueEvaluator(fake.queue, payload);

    expect(result).toBeDefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.data.triggeredByUser).toBe(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
  });

  it("propagates queue.add rejections (Redis down case)", async () => {
    const failing: QueueLike = {
      add: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    await expect(enqueueEvaluator(failing, validPayload())).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("accepts all valid periodType enum values", async () => {
    for (const periodType of ["daily", "weekly", "monthly"] as const) {
      const payload = validPayload({ periodType });
      const result = await enqueueEvaluator(fake.queue, payload);
      expect(result).toBeDefined();
    }
  });
});
