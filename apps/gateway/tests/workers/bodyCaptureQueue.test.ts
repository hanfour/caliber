/**
 * Unit tests for the body-capture queue + enqueue wrapper (Plan 4B Part 3, Task 3.4).
 *
 * Uses a fake queue (no Redis). Covers:
 *   1. Rejects invalid payload (missing requestId)
 *   2. Rejects invalid payload (non-UUID orgId)
 *   3. Applies default retentionDays=90 when omitted
 *   4. Passes requestId as jobId for dedup
 *   5. Uses job name `body-capture`
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobsOptions } from "bullmq";
import {
  enqueueBodyCapture,
  BodyCaptureJobPayload,
  BODY_CAPTURE_JOB_NAME,
  BODY_CAPTURE_QUEUE_NAME,
  BODY_CAPTURE_QUEUE_PREFIX,
  BODY_CAPTURE_DEFAULT_JOB_OPTIONS,
  buildQueueOptions,
  type QueueLike,
} from "../../src/workers/bodyCaptureQueue.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALID_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function validPayload(
  overrides: Partial<BodyCaptureJobPayload> = {},
): BodyCaptureJobPayload {
  return {
    requestId: "req_body_capture_test",
    orgId: VALID_ORG_ID,
    userId: VALID_USER_ID,
    requestBody: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
    responseBody: JSON.stringify({ content: "Hello", stop_reason: "end_turn" }),
    thinkingBody: null,
    attemptErrors: null,
    requestParams: null,
    stopReason: "end_turn",
    clientUserAgent: null,
    clientSessionId: null,
    attachmentsMeta: null,
    cacheControlMarkers: null,
    retentionDays: 90,
    ...overrides,
  };
}

interface RecordedAdd {
  name: string;
  data: BodyCaptureJobPayload;
  opts: JobsOptions | undefined;
}

function makeFakeQueue(): {
  queue: QueueLike;
  calls: RecordedAdd[];
  add: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedAdd[] = [];
  const add = vi.fn(
    async (name: string, data: BodyCaptureJobPayload, opts?: JobsOptions) => {
      calls.push({ name, data, opts });
      return { id: "stub-job-id" };
    },
  );
  return { queue: { add }, calls, add };
}

const STUB_CONNECTION = { host: "localhost", port: 6379 } as const;

// ── Constants tests ──────────────────────────────────────────────────────────

describe("bodyCaptureQueue constants", () => {
  it("exports the design-doc queue identifier as prefix + name", () => {
    expect(`${BODY_CAPTURE_QUEUE_PREFIX}:${BODY_CAPTURE_QUEUE_NAME}`).toBe(
      "caliber:gw:body-capture",
    );
  });

  it("default job options enforce attempts=3 + exponential 1000ms backoff", () => {
    expect(BODY_CAPTURE_DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(BODY_CAPTURE_DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("default job options retain failed jobs for 24h, completed for 1h/1000", () => {
    expect(BODY_CAPTURE_DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 3600,
      count: 1000,
    });
    expect(BODY_CAPTURE_DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 86400,
    });
  });
});

// ── buildQueueOptions tests ──────────────────────────────────────────────────

describe("buildQueueOptions", () => {
  it("uses BODY_CAPTURE_QUEUE_PREFIX when no override supplied", () => {
    const built = buildQueueOptions({ connection: STUB_CONNECTION });
    expect(built.prefix).toBe(BODY_CAPTURE_QUEUE_PREFIX);
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
      BODY_CAPTURE_DEFAULT_JOB_OPTIONS.backoff,
    );
    (built.defaultJobOptions.backoff as { delay: number }).delay = 9999;
    expect(BODY_CAPTURE_DEFAULT_JOB_OPTIONS.backoff.delay).toBe(1000);
  });
});

// ── enqueueBodyCapture tests ─────────────────────────────────────────────────

describe("enqueueBodyCapture", () => {
  let fake: ReturnType<typeof makeFakeQueue>;

  beforeEach(() => {
    fake = makeFakeQueue();
  });

  // Test case 1: Rejects invalid payload (missing requestId)
  it("rejects invalid payload when requestId is missing", async () => {
    const incomplete = {
      orgId: VALID_ORG_ID,
      userId: VALID_USER_ID,
      requestBody: "{}",
      responseBody: "{}",
      // requestId intentionally omitted
    } as unknown;

    await expect(enqueueBodyCapture(fake.queue, incomplete)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  // Test case 2: Rejects invalid payload (non-UUID orgId)
  it("rejects invalid payload when orgId is not a UUID", async () => {
    const bad = {
      ...validPayload(),
      orgId: "not-a-uuid",
    } as unknown;

    await expect(enqueueBodyCapture(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  // Test case 3: Applies default retentionDays=90 when omitted
  it("applies default retentionDays=90 when not provided", async () => {
    const payloadWithoutRetention = {
      requestId: "req_retention_default",
      orgId: VALID_ORG_ID,
      userId: VALID_USER_ID,
      requestBody: "{}",
      responseBody: "{}",
      // retentionDays intentionally omitted
    } as unknown;

    const result = await enqueueBodyCapture(fake.queue, payloadWithoutRetention);
    expect(result.persistence).toBe("queued");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.data.retentionDays).toBe(90);
  });

  // Test case 4: Passes requestId as jobId for dedup
  it("passes requestId as jobId for dedup", async () => {
    const payload = validPayload({ requestId: "req_dedup_body_capture" });
    await enqueueBodyCapture(fake.queue, payload);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.opts?.jobId).toBe("req_dedup_body_capture");
  });

  // Test case 5: Uses job name `body-capture`
  it("uses job name 'body-capture'", async () => {
    await enqueueBodyCapture(fake.queue, validPayload());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.name).toBe(BODY_CAPTURE_JOB_NAME);
    expect(fake.calls[0]!.name).toBe("body-capture");
  });

  it("returns { jobId, persistence: 'queued' } on happy path", async () => {
    const result = await enqueueBodyCapture(
      fake.queue,
      validPayload({ requestId: "req_returned" }),
    );
    expect(result).toEqual({ jobId: "req_returned", persistence: "queued" });
  });

  it("rejects invalid payload when userId is not a UUID", async () => {
    const bad = {
      ...validPayload(),
      userId: "not-a-uuid",
    } as unknown;

    await expect(enqueueBodyCapture(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects invalid payload when retentionDays is non-positive", async () => {
    const bad = validPayload({ retentionDays: 0 });
    await expect(enqueueBodyCapture(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("accepts nullable optional fields (thinkingBody, attemptErrors, etc.)", async () => {
    const payload = validPayload({
      thinkingBody: null,
      attemptErrors: null,
      requestParams: null,
      stopReason: null,
      clientUserAgent: null,
      clientSessionId: null,
      attachmentsMeta: null,
      cacheControlMarkers: null,
    });
    await expect(enqueueBodyCapture(fake.queue, payload)).resolves.toEqual({
      jobId: payload.requestId,
      persistence: "queued",
    });
  });

  it("propagates queue.add rejections (Redis down case)", async () => {
    const failing: QueueLike = {
      add: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    await expect(enqueueBodyCapture(failing, validPayload())).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
