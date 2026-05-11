/**
 * Tests for the inline-DB fallback path in `enqueueUsageLog` (Plan 4A
 * Part 7, Task 7.3).
 *
 * Scope: routing logic only — does this call site dispatch correctly to
 * `queue.add` vs `writeUsageLogBatch`, and does it log + meter the
 * "both failed" case?  SQL correctness of `writeUsageLogBatch` itself is
 * tested by `writeUsageLogBatch.integration.test.ts` and the existing
 * `usageLogWorker.integration.test.ts`.
 *
 * No real DB or Redis — the `db` is a stubbed object whose `transaction`
 * is a `vi.fn`, and `queue.add` is a `vi.fn`.  This keeps these tests
 * fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobsOptions } from "bullmq";
import type { Database } from "@caliber/db";
import {
  enqueueUsageLog,
  UsageLogJobPayload,
  type QueueLike,
  type UsageLogEnqueueFallback,
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
    requestId: "req_fallback_1",
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

function makeFakeQueue(behaviour: "ok" | Error = "ok"): {
  queue: QueueLike;
  calls: RecordedAdd[];
  add: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedAdd[] = [];
  const add = vi.fn(
    async (name: string, data: UsageLogJobPayload, opts?: JobsOptions) => {
      calls.push({ name, data, opts });
      if (behaviour instanceof Error) throw behaviour;
      return { id: data.requestId };
    },
  );
  return { queue: { add }, calls, add };
}

/**
 * Stand-in for `Database` whose `transaction` is a `vi.fn`.  We invoke the
 * caller's transaction body with a tx stub that mirrors only what
 * `writeUsageLogBatch` calls (`insert(table).values(rows)` and
 * `update(table).set(...).where(...)`) so the txn body executes its full
 * code path without needing a real Postgres connection.
 *
 * `txOutcome === "commit"` runs the body to completion; `"throw"` makes the
 * body throw (simulating a constraint violation like UNIQUE(request_id)).
 */
interface FakeDb {
  db: Database;
  transaction: ReturnType<typeof vi.fn>;
}

function makeFakeDb(txOutcome: "commit" | Error = "commit"): FakeDb {
  // Insert chain with the ON CONFLICT DO NOTHING ... RETURNING tail that
  // `writeUsageLogBatch` exercises.  `values(rows)` captures how many rows
  // were offered so `returning()` can resolve with one dedup-result per
  // row — simulating the "no conflicts" happy path the fallback test
  // depends on.  A more adversarial test would simulate a conflict by
  // returning fewer rows, but here we only care about routing.
  let lastInsertedRows: Array<{ requestId: string }> = [];
  const insertChain = {
    values: vi.fn((rows: Array<{ requestId: string }>) => {
      lastInsertedRows = rows.map((r) => ({ requestId: r.requestId }));
      return insertChain;
    }),
    onConflictDoNothing: vi.fn(() => insertChain),
    returning: vi.fn(async () => lastInsertedRows),
  };
  // Update chain: tx.update(table).set(...).where(...).
  const updateChain = {
    set: vi.fn(() => updateChain),
    where: vi.fn(async () => undefined),
  };
  const tx = {
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };

  // `unknown` here keeps TS from chasing the recursive type that the chain
  // stubs build up — the production callee (writeUsageLogBatch) types its
  // own parameter; we just need to invoke the body.
  const transaction = vi.fn(
    async (cb: (tx: unknown) => Promise<void>): Promise<void> => {
      if (txOutcome instanceof Error) {
        // Mirror how Drizzle propagates: cb runs, error escapes, txn rolls
        // back. For our routing-logic test the visible effect is just an
        // outer throw.
        throw txOutcome;
      }
      await cb(tx);
    },
  );

  // Minimal cast — the production code only ever calls db.transaction().
  return {
    db: { transaction } as unknown as Database,
    transaction,
  };
}

function makeFakeLogger(): {
  logger: { error: (obj: unknown, msg?: string) => void };
  errors: { obj: unknown; msg?: string }[];
} {
  const errors: { obj: unknown; msg?: string }[] = [];
  const error = (obj: unknown, msg?: string): void => {
    errors.push({ obj, msg });
  };
  return { logger: { error }, errors };
}

function makeFakeMetrics(): {
  metrics: { inc: () => void };
  incCount: () => number;
} {
  let calls = 0;
  return {
    metrics: {
      inc: (): void => {
        calls += 1;
      },
    },
    incCount: () => calls,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("enqueueUsageLog — inline DB fallback (Task 7.3)", () => {
  let queueOk: ReturnType<typeof makeFakeQueue>;
  let queueFail: ReturnType<typeof makeFakeQueue>;
  let fakeDb: FakeDb;
  let fakeLogger: ReturnType<typeof makeFakeLogger>;
  let fakeMetrics: ReturnType<typeof makeFakeMetrics>;
  let fallback: UsageLogEnqueueFallback;

  beforeEach(() => {
    queueOk = makeFakeQueue("ok");
    queueFail = makeFakeQueue(new Error("ECONNREFUSED — Redis down"));
    fakeDb = makeFakeDb("commit");
    fakeLogger = makeFakeLogger();
    fakeMetrics = makeFakeMetrics();
    fallback = {
      db: fakeDb.db,
      logger: fakeLogger.logger,
      metrics: fakeMetrics.metrics,
    };
  });

  it("writes inline via fallback when queue.add rejects (BullMQ down)", async () => {
    const payload = validPayload({ requestId: "req_inline_ok" });
    const result = await enqueueUsageLog(queueFail.queue, payload, {
      fallback,
    });

    // Routing: queue.add was tried once and the inline txn ran.
    expect(queueFail.add).toHaveBeenCalledTimes(1);
    expect(fakeDb.transaction).toHaveBeenCalledTimes(1);

    // Result reports the inline path so callers can meter it.
    expect(result).toEqual({
      jobId: "req_inline_ok",
      persistence: "inline",
    });

    // Neither logger.error nor the persist-lost counter fires when the
    // fallback succeeds.
    expect(fakeLogger.errors).toHaveLength(0);
    expect(fakeMetrics.incCount()).toBe(0);
  });

  it("does NOT touch the fallback when queue.add resolves", async () => {
    const payload = validPayload({ requestId: "req_happy_path" });
    const result = await enqueueUsageLog(queueOk.queue, payload, {
      fallback,
    });

    expect(queueOk.add).toHaveBeenCalledTimes(1);
    // Critical: the DB transaction stub was never invoked on the happy
    // path.  Otherwise we'd double-write every successful enqueue.
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(fakeLogger.errors).toHaveLength(0);
    expect(fakeMetrics.incCount()).toBe(0);
    expect(result).toEqual({
      jobId: "req_happy_path",
      persistence: "queued",
    });
  });

  it("propagates queue.add error when no fallback is configured (backward compat)", async () => {
    // Mirrors the Task 7.1 callsite that doesn't have a DB handle yet.
    await expect(
      enqueueUsageLog(queueFail.queue, validPayload()),
    ).rejects.toThrow(/ECONNREFUSED/);

    // No fallback wired → no DB write attempted.
    expect(fakeDb.transaction).not.toHaveBeenCalled();
  });

  it("logs gw_usage_persist_lost + meters + re-throws original BullMQ error when both paths fail", async () => {
    // Force the inline txn to also fail (e.g., Postgres unavailable, FK
    // violation, UNIQUE(request_id) collision with a duplicate).
    const dbBoom = makeFakeDb(new Error("FATAL: terminating connection"));
    const payload = validPayload({ requestId: "req_lost_forever" });

    await expect(
      enqueueUsageLog(queueFail.queue, payload, {
        fallback: {
          db: dbBoom.db,
          logger: fakeLogger.logger,
          metrics: fakeMetrics.metrics,
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/); // ← original BullMQ error, not the DB error

    // Structured log entry carries both errors so an operator can replay.
    expect(fakeLogger.errors).toHaveLength(1);
    const entry = fakeLogger.errors[0]!;
    expect(entry.msg).toBe("usage log persist lost");
    const obj = entry.obj as {
      type: string;
      payload: UsageLogJobPayload;
      enqueueError: string;
      persistError: string;
    };
    expect(obj.type).toBe("gw_usage_persist_lost");
    expect(obj.payload.requestId).toBe("req_lost_forever");
    expect(obj.enqueueError).toMatch(/ECONNREFUSED/);
    expect(obj.persistError).toMatch(/terminating connection/);

    // Counter incremented exactly once.
    expect(fakeMetrics.incCount()).toBe(1);
  });

  it("treats the metrics field as optional — dual failure still logs and re-throws", async () => {
    const dbBoom = makeFakeDb(new Error("DB down"));
    await expect(
      enqueueUsageLog(queueFail.queue, validPayload(), {
        fallback: {
          db: dbBoom.db,
          logger: fakeLogger.logger,
          // metrics omitted on purpose
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    expect(fakeLogger.errors).toHaveLength(1);
    expect((fakeLogger.errors[0]!.obj as { type: string }).type).toBe(
      "gw_usage_persist_lost",
    );
  });

  it("validates payload BEFORE any queue.add or fallback work — bad payload throws ZodError without side effects", async () => {
    const incomplete = { requestId: "req_x" } as unknown;

    await expect(
      enqueueUsageLog(queueFail.queue, incomplete, { fallback }),
    ).rejects.toThrow(); // ZodError, not ECONNREFUSED

    // Critical: no DB write, no queue.add — a malformed payload must never
    // hit either backend (would write garbage rows otherwise).
    expect(queueFail.add).not.toHaveBeenCalled();
    expect(fakeDb.transaction).not.toHaveBeenCalled();
    expect(fakeLogger.errors).toHaveLength(0);
    expect(fakeMetrics.incCount()).toBe(0);
  });

  it("inline write receives the validated payload (single-element array)", async () => {
    // Inspect the tx body's calls to verify the payload that reached the
    // INSERT step is the Zod-parsed one (not the raw input).  Since the
    // production fallback wraps the payload in [validated], the insert
    // chain should see exactly one row.
    const payload = validPayload({
      requestId: "req_payload_check",
      apiKeyId: VALID_UUID_2,
    });
    await enqueueUsageLog(queueFail.queue, payload, { fallback });

    // Pull the actual transaction callback the production code passed to
    // db.transaction(...) and execute it against a fresh tx stub that
    // records what writeUsageLogBatch performs:
    //   tx.insert(usageLogs).values(rows)
    //   tx.update(apiKeys).set({...}).where(...)
    expect(fakeDb.transaction).toHaveBeenCalledTimes(1);
    const cb = fakeDb.transaction.mock.calls[0]![0] as (
      tx: unknown,
    ) => Promise<void>;
    expect(typeof cb).toBe("function");

    let capturedRows: Array<{ requestId: string }> | null = null;
    // Mirror the full insert chain `writeUsageLogBatch` exercises:
    // .values(rows).onConflictDoNothing(...).returning(...).  The
    // returning step echoes back all supplied rows so the "no conflicts,
    // quota update runs" path is what the test observes.
    const insertChain = {
      values: vi.fn((rows: Array<{ requestId: string }>) => {
        capturedRows = rows;
        return insertChain;
      }),
      onConflictDoNothing: vi.fn(() => insertChain),
      returning: vi.fn(async () =>
        (capturedRows ?? []).map((r) => ({ requestId: r.requestId })),
      ),
    };
    const updateChain = {
      set: vi.fn(() => updateChain),
      where: vi.fn(async () => undefined),
    };
    const txStub = {
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => updateChain),
    };

    await cb(txStub);

    // Insert step ran with exactly one row whose key fields match the
    // Zod-validated payload (proves the callback forwards `[validated]`,
    // not the raw input or an empty array).
    expect(txStub.insert).toHaveBeenCalledTimes(1);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(insertChain.returning).toHaveBeenCalledTimes(1);
    expect(capturedRows).not.toBeNull();
    const rows = capturedRows as unknown as {
      requestId: string;
      apiKeyId: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe("req_payload_check");
    expect(rows[0]!.apiKeyId).toBe(VALID_UUID_2);

    // Update step ran for the single distinct apiKeyId in the batch.
    expect(txStub.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledTimes(1);
    expect(updateChain.where).toHaveBeenCalledTimes(1);
  });
});
