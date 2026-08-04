/**
 * Integration tests for the `replay` tRPC router (Task 8, single-request-replay).
 *
 * Every test drives the REAL `appRouter`, not a locally-composed sub-router, so
 * the suite also pins that `replay` is actually mounted — a router that exists
 * but is never registered would 404 at runtime and every assertion here would
 * fail loudly.
 *
 * The queue is injected as a fake: `enqueue` spends real money on a real
 * upstream when wired to the gateway worker, so the api-side contract we pin is
 * "what got enqueued, and only after the row committed" — never a live Redis.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import * as schema from "@caliber/db/schema";
import {
  apiKeys,
  auditLogs,
  replayRuns,
  requestBodies,
  upstreamAccounts,
  usageLogs,
} from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import { REPLAY_JOB_NAME, type QueueLike } from "@caliber/queue";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
// Not re-exported from factories/index.js — imported from the module directly.
import { ignorePoolTeardownErrors } from "../../factories/db.js";
import { createCallerFactory } from "../../../src/trpc/procedures.js";
import { appRouter } from "../../../src/trpc/router.js";
import { REPLAY_HOURLY_LIMIT } from "../../../src/trpc/routers/replay.js";
import type { TrpcContext } from "../../../src/trpc/context.js";

const createAppCaller = createCallerFactory(appRouter);

const TARGET_MODEL = "claude-sonnet-5";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

// ─── Harness ──────────────────────────────────────────────────────────────────

interface FakeQueue {
  queue: QueueLike;
  add: ReturnType<typeof vi.fn>;
}

/** A queue double whose `add` records calls and resolves. */
function makeFakeQueue(impl?: (...args: unknown[]) => Promise<unknown>): FakeQueue {
  const add = impl ? vi.fn(impl) : vi.fn().mockResolvedValue({});
  return { queue: { add } as unknown as QueueLike, add };
}

async function callerFor(opts: {
  db: Database;
  userId: string;
  replayQueue?: QueueLike;
  env?: ServerEnv;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  const ctx: TrpcContext = {
    db: opts.db,
    user: { id: opts.userId, email: `${opts.userId}@t.test` },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
    replayQueue: opts.replayQueue,
  };
  return createAppCaller(ctx);
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;

async function seedUpstreamAccount(db: Database, orgId: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `replay-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

async function seedApiKey(db: Database, opts: { orgId: string; userId: string }) {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      name: `replay-key-${seedCounter}`,
      keyHash: `replay-hash-${seedCounter}`,
      keyPrefix: `sk-replay-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

/**
 * Insert one `usage_logs` row plus (unless `withBody: false`) its captured
 * `request_bodies` row. The sealed blobs are dummies — nothing in this router
 * decrypts them; that is the worker's job.
 */
async function seedCapturedRequest(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    apiKeyId: string;
    accountId: string;
    bodyTruncated?: boolean;
    retentionUntil?: Date;
    withBody?: boolean;
    /** Override the id. Defaults to a uuid, matching what the gateway mints. */
    requestId?: string;
  },
) {
  seedCounter += 1;
  // apps/gateway sets `genReqId: () => randomUUID()`, so a real captured
  // request always carries a uuid here even though the column is `text`.
  const requestId = opts.requestId ?? randomUUID();
  await db.insert(usageLogs).values({
    requestId,
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5",
    platform: "anthropic",
    surface: "api",
    inputTokens: 10,
    outputTokens: 20,
    totalCost: "0.001",
    stream: false,
    statusCode: 200,
    durationMs: 100,
  });

  if (opts.withBody !== false) {
    const dummy = Buffer.from("sealed");
    await db.insert(requestBodies).values({
      requestId,
      orgId: opts.orgId,
      requestBodySealed: dummy,
      responseBodySealed: dummy,
      bodyTruncated: opts.bodyTruncated ?? false,
      retentionUntil:
        opts.retentionUntil ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  return requestId;
}

/**
 * A fresh org with three distinct actors and one captured request owned by
 * `owner`. Seeded per test (not once in beforeAll) because the hourly rate
 * limit counts `replay_runs` rows per triggering user — sharing an actor
 * across tests would leak one test's quota into the next.
 */
async function seedScenario(
  db: Database,
  opts: { llmEvalEnabled?: boolean } = {},
) {
  // Replay borrows the org's LLM-eval key, so `llm_eval_enabled` is a real
  // precondition of the endpoint — on by default here, off only where a test
  // pins the refusal.
  const org = await makeOrg(db, { llmEvalEnabled: opts.llmEvalEnabled ?? true });
  const owner = await makeUser(db, { orgId: org.id });
  const otherMember = await makeUser(db, { orgId: org.id });
  const admin = await makeUser(db, {
    role: "org_admin",
    scopeType: "organization",
    scopeId: org.id,
    orgId: org.id,
  });
  const accountId = await seedUpstreamAccount(db, org.id);
  const apiKeyId = await seedApiKey(db, { orgId: org.id, userId: owner.id });
  const requestId = await seedCapturedRequest(db, {
    orgId: org.id,
    userId: owner.id,
    apiKeyId,
    accountId,
  });
  return { org, owner, otherMember, admin, accountId, apiKeyId, requestId };
}

function runsFor(db: Database, sourceRequestId: string) {
  return db
    .select()
    .from(replayRuns)
    .where(eq(replayRuns.sourceRequestId, sourceRequestId));
}

// ─── replay.enqueue ───────────────────────────────────────────────────────────

describe("replay.enqueue", () => {
  it("hides the feature when ENABLE_EVALUATOR=false → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
      env: { ...defaultTestEnv, ENABLE_EVALUATOR: false },
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(q.add).not.toHaveBeenCalled();
  });

  it("unknown requestId → NOT_FOUND and nothing enqueued", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.admin.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: "no-such-request-id",
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(q.add).not.toHaveBeenCalled();
  });

  it("a request belonging to another org → NOT_FOUND (org scoping)", async () => {
    const a = await seedScenario(t.db);
    const b = await seedScenario(t.db);
    const q = makeFakeQueue();
    // b's admin is an org_admin of b only; asking for a's request under b's org.
    const caller = await callerFor({
      db: t.db,
      userId: b.admin.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: b.org.id,
        requestId: a.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(q.add).not.toHaveBeenCalled();
  });

  it("neither the author nor an org_admin → FORBIDDEN and nothing enqueued", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.otherMember.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(q.add).not.toHaveBeenCalled();
    expect(await runsFor(t.db, s.requestId)).toHaveLength(0);
  });

  it("body_truncated → PRECONDITION_FAILED, no row, nothing enqueued", async () => {
    const s = await seedScenario(t.db);
    const truncated = await seedCapturedRequest(t.db, {
      orgId: s.org.id,
      userId: s.owner.id,
      apiKeyId: s.apiKeyId,
      accountId: s.accountId,
      bodyTruncated: true,
    });
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: truncated,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(q.add).not.toHaveBeenCalled();
    expect(await runsFor(t.db, truncated)).toHaveLength(0);
  });

  it("retention already expired → PRECONDITION_FAILED, nothing enqueued", async () => {
    const s = await seedScenario(t.db);
    const expired = await seedCapturedRequest(t.db, {
      orgId: s.org.id,
      userId: s.owner.id,
      apiKeyId: s.apiKeyId,
      accountId: s.accountId,
      retentionUntil: new Date(Date.now() - 60_000),
    });
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: expired,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(q.add).not.toHaveBeenCalled();
    expect(await runsFor(t.db, expired)).toHaveLength(0);
  });

  it("body never captured → PRECONDITION_FAILED, nothing enqueued", async () => {
    const s = await seedScenario(t.db);
    const bodyless = await seedCapturedRequest(t.db, {
      orgId: s.org.id,
      userId: s.owner.id,
      apiKeyId: s.apiKeyId,
      accountId: s.accountId,
      withBody: false,
    });
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: bodyless,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(q.add).not.toHaveBeenCalled();
  });

  // Replay authenticates with the org's LLM-eval key, so the org's own
  // `llm_eval_enabled` switch is a precondition of the feature (design doc:
  // 「任一不成立時，`replay.enqueue` 必須以明確錯誤拒絕」). It is reachable, not
  // hypothetical: turning eval off leaves the provisioned key in Redis forever
  // (no TTL, no deprovision path anywhere), so without this check an enqueue
  // would happily buy a billed upstream call and decrypt a member's full prompt
  // in a configuration where the org said no. Refusing here means no billed
  // round trip is ever queued.
  it("org 已關閉 llm_eval_enabled → PRECONDITION_FAILED，什麼都不入列", async () => {
    const s = await seedScenario(t.db, { llmEvalEnabled: false });
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(q.add).not.toHaveBeenCalled();
    expect(await runsFor(t.db, s.requestId)).toHaveLength(0);
  });

  // The refusal must be a translatable key, not English prose: a CI audit step
  // (scripts/audit-zod-i18n.mjs) rejects inline literals and does not run under
  // turbo, so nothing local would catch a regression here.
  it("該拒絕訊息走 i18n key，而不是寫死的英文句子", async () => {
    const s = await seedScenario(t.db, { llmEvalEnabled: false });
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: makeFakeQueue().queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({
      message: "validation.custom.replay.evalDisabled",
    });
  });

  it("the author gets a queued replay_runs row and a job whose jobId is the bare runId", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    const res = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const rows = await runsFor(t.db, s.requestId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(res.runId);
    expect(row.status).toBe("queued");
    expect(row.triggeredBy).toBe(s.owner.id);
    expect(row.orgId).toBe(s.org.id);
    expect(row.targetModel).toBe(TARGET_MODEL);
    expect(row.replayRequestId).toBeNull();
    expect(row.completedAt).toBeNull();

    expect(q.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = q.add.mock.calls[0]!;
    expect(jobName).toBe(REPLAY_JOB_NAME);
    expect(payload).toEqual({
      runId: res.runId,
      orgId: s.org.id,
      sourceRequestId: s.requestId,
      targetModel: TARGET_MODEL,
    });
    // Bare runId — no colon, no composed string (BullMQ 5.x rejects those).
    expect(opts).toMatchObject({ jobId: res.runId });
  });

  it("an org_admin may replay another member's request", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.admin.id,
      replayQueue: q.queue,
    });

    const res = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const rows = await runsFor(t.db, s.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.triggeredBy).toBe(s.admin.id);
    expect(res.runId).toBe(rows[0]!.id);
  });

  it("the replay_runs row is committed BEFORE the job is enqueued", async () => {
    const s = await seedScenario(t.db);
    // The worker's claim fence logs-and-drops when it finds no `queued` row, so
    // a job delivered before the INSERT commits is silently lost and no money
    // is ever spent — but the UI shows a run that never progresses. Reading the
    // row from a *different* pooled connection inside `add` proves the
    // transaction had already committed at enqueue time.
    let visibleAtEnqueue = -1;
    const q = makeFakeQueue(async () => {
      visibleAtEnqueue = (await runsFor(t.db, s.requestId)).length;
      return {};
    });
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    expect(visibleAtEnqueue).toBe(1);
  });

  it("writes an audit log naming the actor, the source request and the run", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.admin.id,
      replayQueue: q.queue,
    });

    const res = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "request.replay"),
          eq(auditLogs.targetId, s.requestId),
        ),
      )
      .then((r) => r[0]);

    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(s.admin.id);
    expect(audit!.targetType).toBe("usage_log");
    expect(audit!.orgId).toBe(s.org.id);
    expect(audit!.metadata).toMatchObject({
      runId: res.runId,
      sourceRequestId: s.requestId,
      targetModel: TARGET_MODEL,
      targetUserId: s.owner.id,
    });
  });

  it("still audits a request whose id is not uuid-shaped (the column is text)", async () => {
    // audit_logs.target_id is `uuid` while usage_logs.request_id is `text`.
    // A non-uuid id must not blow up the audit INSERT and roll back an
    // otherwise legitimate replay — metadata.sourceRequestId carries the link.
    const s = await seedScenario(t.db);
    const textId = `legacy-request-${Date.now()}`;
    await seedCapturedRequest(t.db, {
      orgId: s.org.id,
      userId: s.owner.id,
      apiKeyId: s.apiKeyId,
      accountId: s.accountId,
      requestId: textId,
    });
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    const res = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: textId,
      targetModel: TARGET_MODEL,
    });

    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "request.replay"),
          sql`${auditLogs.metadata} ->> 'runId' = ${res.runId}`,
        ),
      )
      .then((r) => r[0]);

    expect(audit).toBeDefined();
    expect(audit!.targetId).toBeNull();
    expect(audit!.metadata).toMatchObject({ sourceRequestId: textId });
  });

  it(`the ${REPLAY_HOURLY_LIMIT}th replay in an hour is the last → TOO_MANY_REQUESTS`, async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    for (let i = 0; i < REPLAY_HOURLY_LIMIT; i++) {
      await caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      });
    }

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(q.add).toHaveBeenCalledTimes(REPLAY_HOURLY_LIMIT);
    expect(await runsFor(t.db, s.requestId)).toHaveLength(REPLAY_HOURLY_LIMIT);
  });

  it(`${REPLAY_HOURLY_LIMIT + 10} CONCURRENT calls still buy only ${REPLAY_HOURLY_LIMIT} replays`, async () => {
    // The sequential test above passes with or without a lock, so it does not
    // cover the real threat: the only limiter in front of this endpoint is the
    // global /trpc one at API_TRPC_RPM_LIMIT=2000 per minute, so an authorised
    // caller can fire hundreds of enqueues at once. Counting outside the
    // transaction lets every one of them read the same pre-limit count and
    // buy a paid upstream call.
    const s = await seedScenario(t.db);
    const attempts = REPLAY_HOURLY_LIMIT + 10;

    // A dedicated, larger pool. The shared fixture pool (factories/db.ts) uses
    // node-postgres' default max of 10, which would throttle these calls into
    // batches of 10 — and 10 divides REPLAY_HOURLY_LIMIT exactly, so an
    // unlocked implementation would coincidentally land on 20 and the test
    // would pass for the wrong reason. With max >= attempts they are genuinely
    // simultaneous, so removing the lock produces `attempts` rows and fails.
    const pool = ignorePoolTeardownErrors(
      new pg.Pool({ connectionString: t.url, max: attempts + 5 }),
    );
    const concurrentDb = drizzle(pool, { schema }) as unknown as Database;

    try {
      const q = makeFakeQueue();
      const callers = await Promise.all(
        Array.from({ length: attempts }, () =>
          callerFor({
            db: concurrentDb,
            userId: s.owner.id,
            replayQueue: q.queue,
          }),
        ),
      );

      const results = await Promise.allSettled(
        callers.map((c) =>
          c.replay.enqueue({
            orgId: s.org.id,
            requestId: s.requestId,
            targetModel: TARGET_MODEL,
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(REPLAY_HOURLY_LIMIT);
      expect(rejected).toHaveLength(attempts - REPLAY_HOURLY_LIMIT);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ code: "TOO_MANY_REQUESTS" });
      }

      // The rows are what actually cost money — assert on them, not just on
      // the returned promises.
      expect(await runsFor(t.db, s.requestId)).toHaveLength(REPLAY_HOURLY_LIMIT);
      expect(q.add).toHaveBeenCalledTimes(REPLAY_HOURLY_LIMIT);
    } finally {
      await pool.end();
    }
  });

  it("one user's spent quota does not block another user", async () => {
    const s = await seedScenario(t.db);
    const ownerQueue = makeFakeQueue();
    const ownerCaller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: ownerQueue.queue,
    });
    for (let i = 0; i < REPLAY_HOURLY_LIMIT; i++) {
      await ownerCaller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      });
    }

    const adminQueue = makeFakeQueue();
    const adminCaller = await callerFor({
      db: t.db,
      userId: s.admin.id,
      replayQueue: adminQueue.queue,
    });
    await expect(
      adminCaller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("no queue wired → PRECONDITION_FAILED and no orphan queued row", async () => {
    const s = await seedScenario(t.db);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await runsFor(t.db, s.requestId)).toHaveLength(0);
  });

  it("a failing enqueue removes the row it could not hand off", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue(async () => {
      throw new Error("redis down");
    });
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: TARGET_MODEL,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    // A row left behind here would sit at `queued` forever with no failure
    // reason — the exact silent-stall this feature must not produce.
    expect(await runsFor(t.db, s.requestId)).toHaveLength(0);
  });

  it("rejects a blank targetModel at the boundary", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    await expect(
      caller.replay.enqueue({
        orgId: s.org.id,
        requestId: s.requestId,
        targetModel: "   ",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(q.add).not.toHaveBeenCalled();
  });
});

// ─── replay.get ───────────────────────────────────────────────────────────────

describe("replay.get", () => {
  it("hides the feature when ENABLE_EVALUATOR=false → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const ownerCaller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });
    const { runId } = await ownerCaller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const gated = await callerFor({
      db: t.db,
      userId: s.owner.id,
      env: { ...defaultTestEnv, ENABLE_EVALUATOR: false },
    });
    await expect(gated.replay.get({ runId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns the run to its subject's author", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const ownerCaller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });
    const { runId } = await ownerCaller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const run = await ownerCaller.replay.get({ runId });
    expect(run).toMatchObject({
      id: runId,
      orgId: s.org.id,
      sourceRequestId: s.requestId,
      targetModel: TARGET_MODEL,
      status: "queued",
      triggeredBy: s.owner.id,
      failureReason: null,
      replayRequestId: null,
      fidelity: null,
    });
  });

  it("denies a member who is neither the author nor an org_admin → FORBIDDEN", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const ownerCaller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });
    const { runId } = await ownerCaller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const intruder = await callerFor({ db: t.db, userId: s.otherMember.id });
    await expect(intruder.replay.get({ runId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("denies an org_admin of a different org → FORBIDDEN", async () => {
    const a = await seedScenario(t.db);
    const b = await seedScenario(t.db);
    const q = makeFakeQueue();
    const ownerCaller = await callerFor({
      db: t.db,
      userId: a.owner.id,
      replayQueue: q.queue,
    });
    const { runId } = await ownerCaller.replay.enqueue({
      orgId: a.org.id,
      requestId: a.requestId,
      targetModel: TARGET_MODEL,
    });

    const foreignAdmin = await callerFor({ db: t.db, userId: b.admin.id });
    await expect(foreignAdmin.replay.get({ runId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("unknown runId → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const caller = await callerFor({ db: t.db, userId: s.admin.id });
    await expect(
      caller.replay.get({ runId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─── replay.listForRequest ────────────────────────────────────────────────────

describe("replay.listForRequest", () => {
  it("hides the feature when ENABLE_EVALUATOR=false → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const gated = await callerFor({
      db: t.db,
      userId: s.owner.id,
      env: { ...defaultTestEnv, ENABLE_EVALUATOR: false },
    });
    await expect(
      gated.replay.listForRequest({ orgId: s.org.id, requestId: s.requestId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists every run for the request, newest first", async () => {
    const s = await seedScenario(t.db);
    const q = makeFakeQueue();
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      replayQueue: q.queue,
    });

    const first = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: "claude-haiku-4-5",
    });
    const second = await caller.replay.enqueue({
      orgId: s.org.id,
      requestId: s.requestId,
      targetModel: TARGET_MODEL,
    });

    const rows = await caller.replay.listForRequest({
      orgId: s.org.id,
      requestId: s.requestId,
    });
    expect(rows).toHaveLength(2);
    const expected = await t.db
      .select({ id: replayRuns.id })
      .from(replayRuns)
      .where(eq(replayRuns.sourceRequestId, s.requestId))
      .orderBy(desc(replayRuns.createdAt), desc(replayRuns.id));
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set([first.runId, second.runId]),
    );
  });

  it("returns an empty list for a request never replayed", async () => {
    const s = await seedScenario(t.db);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });
    await expect(
      caller.replay.listForRequest({
        orgId: s.org.id,
        requestId: s.requestId,
      }),
    ).resolves.toEqual([]);
  });

  it("denies a member who is neither the author nor an org_admin → FORBIDDEN", async () => {
    const s = await seedScenario(t.db);
    const intruder = await callerFor({ db: t.db, userId: s.otherMember.id });
    await expect(
      intruder.replay.listForRequest({
        orgId: s.org.id,
        requestId: s.requestId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a request from another org → NOT_FOUND", async () => {
    const a = await seedScenario(t.db);
    const b = await seedScenario(t.db);
    const caller = await callerFor({ db: t.db, userId: b.admin.id });
    await expect(
      caller.replay.listForRequest({
        orgId: b.org.id,
        requestId: a.requestId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
