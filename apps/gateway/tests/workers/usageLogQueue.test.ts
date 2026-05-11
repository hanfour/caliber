import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobsOptions } from "bullmq";
import {
  buildQueueOptions,
  enqueueUsageLog,
  UsageLogJobPayload,
  USAGE_LOG_JOB_NAME,
  USAGE_LOG_QUEUE_NAME,
  USAGE_LOG_QUEUE_PREFIX,
  USAGE_LOG_DEFAULT_JOB_OPTIONS,
  type QueueLike,
} from "../../src/workers/usageLogQueue.js";
import { makeUsageLogJobPayload } from "../factories/usageLogPayload.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID_1 = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_3 = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_4 = "44444444-4444-4444-8444-444444444444";

function validPayload(
  overrides: Partial<UsageLogJobPayload> = {},
): UsageLogJobPayload {
  return makeUsageLogJobPayload({
    requestId: "req_abcdef123",
    userId: VALID_UUID_1,
    apiKeyId: VALID_UUID_2,
    accountId: VALID_UUID_3,
    orgId: VALID_UUID_4,
    ...overrides,
  });
}

interface RecordedAdd {
  name: string;
  data: UsageLogJobPayload;
  opts: JobsOptions | undefined;
}

function makeFakeQueue(returnValue: unknown = { id: "stub-job-id" }): {
  queue: QueueLike;
  calls: RecordedAdd[];
  add: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedAdd[] = [];
  const add = vi.fn(
    async (name: string, data: UsageLogJobPayload, opts?: JobsOptions) => {
      calls.push({ name, data, opts });
      return returnValue;
    },
  );
  return { queue: { add }, calls, add };
}

// Stand-in connection — `buildQueueOptions` is a pure object-shaping function
// and never touches the connection field, so any object passes through.
const STUB_CONNECTION = { host: "localhost", port: 6379 } as const;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usageLogQueue constants", () => {
  it("exports the design-doc queue identifier as prefix + name", () => {
    // The full Redis namespace BullMQ writes to is `${prefix}:${name}:*` —
    // verify the two halves combine to "caliber:gw:usage-log".
    expect(`${USAGE_LOG_QUEUE_PREFIX}:${USAGE_LOG_QUEUE_NAME}`).toBe(
      "caliber:gw:usage-log",
    );
  });

  it("default job options enforce attempts=3 + exponential 1000ms backoff", () => {
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("default job options retain failed jobs for 24h, completed for 1h", () => {
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 3600,
      count: 1000,
    });
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 86400,
    });
  });
});

describe("buildQueueOptions", () => {
  // These tests pin the Queue-construction path: defaults flow from
  // USAGE_LOG_DEFAULT_JOB_OPTIONS into `defaultJobOptions`, BullMQ then merges
  // those into every Queue.add() call. enqueueUsageLog deliberately does NOT
  // re-spread them.

  it("uses USAGE_LOG_QUEUE_PREFIX when no prefix override is supplied", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.prefix).toBe(USAGE_LOG_QUEUE_PREFIX);
  });

  it("honours an explicit prefix override", () => {
    const built = buildQueueOptions({
      connection: STUB_CONNECTION,
      prefix: "test:gw",
    });
    expect(built.prefix).toBe("test:gw");
  });

  it("forwards the connection object verbatim to BullMQ", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.connection).toBe(STUB_CONNECTION);
  });

  it("includes attempts=3 + exponential backoff in defaultJobOptions", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.defaultJobOptions.attempts).toBe(3);
    expect(built.defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("includes removeOnComplete and removeOnFail retention in defaultJobOptions", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.defaultJobOptions.removeOnComplete).toEqual({
      age: 3600,
      count: 1000,
    });
    expect(built.defaultJobOptions.removeOnFail).toEqual({ age: 86400 });
  });

  it("deep-copies the nested backoff object so mutation cannot leak into the module-level constant", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    // Identity check: returned backoff must not be the same reference as the
    // shared constant. If it were, mutating the returned options would corrupt
    // every subsequent buildQueueOptions() call.
    expect(built.defaultJobOptions.backoff).not.toBe(
      USAGE_LOG_DEFAULT_JOB_OPTIONS.backoff,
    );

    // Mutate the copy and verify the constant is untouched.
    (built.defaultJobOptions.backoff as { delay: number }).delay = 9999;
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.backoff.delay).toBe(1000);
  });

  it("merges caller-supplied defaultJobOptions on top of the module defaults", () => {
    const built = buildQueueOptions({
      connection: STUB_CONNECTION,
      defaultJobOptions: { attempts: 5 },
    });
    expect(built.defaultJobOptions.attempts).toBe(5);
    // Untouched defaults should still be present.
    expect(built.defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
    expect(built.defaultJobOptions.removeOnFail).toEqual({ age: 86400 });
  });

  it("lets caller-supplied backoff fully replace the default backoff", () => {
    const built = buildQueueOptions({
      connection: STUB_CONNECTION,
      defaultJobOptions: { backoff: { type: "fixed", delay: 500 } },
    });
    expect(built.defaultJobOptions.backoff).toEqual({
      type: "fixed",
      delay: 500,
    });
  });
});

describe("enqueueUsageLog", () => {
  let fake: ReturnType<typeof makeFakeQueue>;

  beforeEach(() => {
    fake = makeFakeQueue();
  });

  it("passes jobId = payload.requestId for dedup", async () => {
    const payload = validPayload({ requestId: "req_dedup_check" });
    await enqueueUsageLog(fake.queue, payload);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.opts?.jobId).toBe("req_dedup_check");
  });

  it("passes job name = 'usage-log' and the validated data verbatim", async () => {
    const payload = validPayload();
    await enqueueUsageLog(fake.queue, payload);

    expect(fake.calls[0]!.name).toBe(USAGE_LOG_JOB_NAME);
    expect(fake.calls[0]!.data).toEqual(payload);
  });

  it("passes ONLY { jobId } in per-call opts when no caller overrides — Queue-level defaults supply the rest", async () => {
    // Critical regression test: enqueueUsageLog must NOT re-spread the
    // module defaults into per-call opts. Per-call opts win in BullMQ and
    // would silently shadow whatever the Queue was constructed with.
    await enqueueUsageLog(fake.queue, validPayload({ requestId: "req_only" }));

    const opts = fake.calls[0]!.opts!;
    expect(Object.keys(opts).sort()).toEqual(["jobId"]);
    expect(opts.jobId).toBe("req_only");
    // Sanity: defaults explicitly NOT in per-call opts.
    expect(opts.attempts).toBeUndefined();
    expect(opts.backoff).toBeUndefined();
    expect(opts.removeOnComplete).toBeUndefined();
    expect(opts.removeOnFail).toBeUndefined();
  });

  it("returns { jobId, persistence: 'queued' } on the happy path", async () => {
    // persistence='queued' is the Task 7.3 marker that the row was handed
    // off to BullMQ (vs written inline by the fallback path).
    const result = await enqueueUsageLog(
      fake.queue,
      validPayload({ requestId: "req_returned_id" }),
    );
    expect(result).toEqual({
      jobId: "req_returned_id",
      persistence: "queued",
    });
  });

  it("rejects payloads missing required fields (Zod validation)", async () => {
    const incomplete = { requestId: "req_x" } as unknown;
    await expect(enqueueUsageLog(fake.queue, incomplete)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with non-decimal cost strings", async () => {
    const bad = validPayload({
      totalCost: "not-a-number" as unknown as string,
    });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow(
      /decimal-formatted/,
    );
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with non-UUID accountId", async () => {
    const bad = validPayload({ accountId: "not-a-uuid" });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads where failedAccountIds contains a non-UUID element", async () => {
    // Documents that array elements are validated, not just the array itself.
    const bad = validPayload({ failedAccountIds: ["not-a-uuid"] });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with negative token counts", async () => {
    const bad = validPayload({ inputTokens: -1 });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("accepts nullable fields (teamId, firstTokenMs, userAgent, ipAddress)", async () => {
    const payload = validPayload({
      teamId: null,
      firstTokenMs: null,
      bufferReleasedAtMs: null,
      userAgent: null,
      ipAddress: null,
    });
    await expect(enqueueUsageLog(fake.queue, payload)).resolves.toEqual({
      jobId: payload.requestId,
      persistence: "queued",
    });
  });

  it("propagates queue.add rejections (Redis down case)", async () => {
    const failing: QueueLike = {
      add: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    await expect(enqueueUsageLog(failing, validPayload())).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("per-call jobOptions are passed through verbatim, but jobId is always derived from payload.requestId", async () => {
    await enqueueUsageLog(fake.queue, validPayload({ requestId: "req_ovr" }), {
      jobOptions: { attempts: 7, jobId: "ignored-by-impl" },
    });

    const opts = fake.calls[0]!.opts!;
    // Caller-supplied attempts flows through.
    expect(opts.attempts).toBe(7);
    // jobId is always derived from payload.requestId, never user-overridable.
    expect(opts.jobId).toBe("req_ovr");
    // No defaults re-spread by enqueueUsageLog — backoff/removeOn* must come
    // from the Queue's defaultJobOptions, not from per-call opts.
    expect(opts.backoff).toBeUndefined();
    expect(opts.removeOnComplete).toBeUndefined();
    expect(opts.removeOnFail).toBeUndefined();
  });
});
