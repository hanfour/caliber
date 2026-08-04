/**
 * Integration tests for `replay.getComparison` (Task 11, single-request-replay).
 *
 * This endpoint is the one place in apps/api that DECRYPTS another person's
 * captured content, and the one place whose output an operator reads to
 * conclude "the model was at fault" or "we were". Both properties drive what
 * is pinned here:
 *
 *  - permission and org scoping, because reading a comparison is reading
 *    decrypted content (same bar as starting a replay);
 *  - the comparability flags, because a number rendered as comparable when it
 *    is not is worse than no feature at all.
 *
 * NOTE on the brief's stated test path (`apps/api/tests/trpc/…`): that
 * directory is matched by the UNIT vitest config, which excludes
 * `tests/integration/**` and has no database. Integration tests live under
 * `tests/integration/trpc/`, alongside `replay.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  apiKeys,
  replayRuns,
  requestBodies,
  upstreamAccounts,
  usageLogs,
} from "@caliber/db";
import { encryptBodyRaw } from "@caliber/gateway-core";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory } from "../../../src/trpc/procedures.js";
import { appRouter } from "../../../src/trpc/router.js";
import {
  REPLAY_STALE_RUNNING_MS,
  RESULT_MISSING_FAILURE_REASON,
  STALE_RUNNING_FAILURE_REASON,
  UNKNOWN_STATUS_FAILURE_REASON,
} from "../../../src/services/replayComparison.js";
import type { TrpcContext } from "../../../src/trpc/context.js";

const createAppCaller = createCallerFactory(appRouter);

const MASTER_KEY = defaultTestEnv.CREDENTIAL_ENCRYPTION_KEY!;

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

// ─── Harness ──────────────────────────────────────────────────────────────────

async function callerFor(opts: {
  db: Database;
  userId: string;
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
  };
  return createAppCaller(ctx);
}

/**
 * The on-disk framing for `request_bodies.*_sealed`, restated independently of
 * the implementation: `nonce || ciphertext || authTag`. Written out here on
 * purpose — if the production framing ever drifts, these tests must fail
 * rather than drift along with it.
 */
function sealBody(requestId: string, plaintext: string): Buffer {
  const { nonce, ciphertext, authTag } = encryptBodyRaw({
    masterKeyHex: MASTER_KEY,
    requestId,
    plaintext,
  });
  return Buffer.concat([nonce, ciphertext, authTag]);
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;

async function seedUpstreamAccount(db: Database, orgId: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `cmp-acct-${seedCounter}`,
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
      name: `cmp-key-${seedCounter}`,
      keyHash: `cmp-hash-${seedCounter}`,
      keyPrefix: `sk-cmp-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

interface SeedRequestOpts {
  orgId: string;
  userId: string;
  apiKeyId: string;
  accountId: string;
  requestedModel?: string;
  upstreamModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalCost?: string;
  durationMs?: number;
  replayOfRequestId?: string;
  /** Plaintext JSON sealed into `response_body_sealed`. */
  responseBody?: string;
  /** Store a blob that cannot be decrypted with the configured master key. */
  corruptBody?: boolean;
  /** Skip the `request_bodies` row entirely (retention purge / capture off). */
  withBody?: boolean;
}

async function seedCapturedRequest(db: Database, opts: SeedRequestOpts) {
  const requestId = randomUUID();
  await db.insert(usageLogs).values({
    requestId,
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    requestedModel: opts.requestedModel ?? "claude-sonnet-4-5",
    upstreamModel: opts.upstreamModel ?? "claude-sonnet-4-5-20250929",
    platform: "anthropic",
    surface: "api",
    inputTokens: opts.inputTokens ?? 10,
    outputTokens: opts.outputTokens ?? 20,
    cacheReadTokens: opts.cacheReadTokens ?? 0,
    totalCost: opts.totalCost ?? "0.0010000000",
    stream: false,
    statusCode: 200,
    durationMs: opts.durationMs ?? 1234,
    replayOfRequestId: opts.replayOfRequestId ?? null,
  });

  if (opts.withBody !== false) {
    const plaintext = opts.responseBody ?? '{"content":[{"text":"hello"}]}';
    await db.insert(requestBodies).values({
      requestId,
      orgId: opts.orgId,
      requestBodySealed: sealBody(requestId, '{"model":"m"}'),
      responseBodySealed: opts.corruptBody
        ? Buffer.from("not-a-sealed-blob-at-all")
        : sealBody(requestId, plaintext),
      retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  return requestId;
}

const SEEDED_FIDELITY = {
  toolResultTruncated: false,
  originalCacheReadTokens: 0,
  originalAccountId: null,
  originalAccountStillExists: true,
  streamingDisabled: true,
} as const;

async function seedRun(
  db: Database,
  opts: {
    orgId: string;
    sourceRequestId: string;
    triggeredBy: string;
    targetModel?: string;
    status: "queued" | "running" | "ok" | "failed";
    replayRequestId?: string;
    failureReason?: string;
    fidelity?: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  const [row] = await db
    .insert(replayRuns)
    .values({
      orgId: opts.orgId,
      sourceRequestId: opts.sourceRequestId,
      targetModel: opts.targetModel ?? "claude-haiku-4-5",
      triggeredBy: opts.triggeredBy,
      status: opts.status,
      replayRequestId: opts.replayRequestId ?? null,
      failureReason: opts.failureReason ?? null,
      fidelity: opts.fidelity ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: replayRuns.id });
  return row!.id;
}

/**
 * A fresh org with three actors, one captured source request and one COMPLETED
 * replay of it. Seeded per test so no test can observe another's rows.
 */
async function seedScenario(
  db: Database,
  sourceOverrides: Partial<SeedRequestOpts> = {},
) {
  const org = await makeOrg(db);
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

  const base = { orgId: org.id, userId: owner.id, apiKeyId, accountId };
  const sourceRequestId = await seedCapturedRequest(db, {
    ...base,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250929",
    inputTokens: 100,
    outputTokens: 200,
    totalCost: "0.0500000000",
    durationMs: 4321,
    responseBody: '{"content":[{"type":"text","text":"source answer"}]}',
    ...sourceOverrides,
  });

  return {
    org,
    owner,
    otherMember,
    admin,
    accountId,
    apiKeyId,
    base,
    sourceRequestId,
  };
}

/** Seed a completed (`ok`) run plus the replay's own captured request. */
async function seedCompletedRun(
  db: Database,
  s: Awaited<ReturnType<typeof seedScenario>>,
  overrides: Partial<SeedRequestOpts> = {},
) {
  const replayRequestId = await seedCapturedRequest(db, {
    ...s.base,
    requestedModel: "claude-haiku-4-5",
    upstreamModel: "claude-haiku-4-5-20251001",
    inputTokens: 101,
    outputTokens: 55,
    totalCost: "0.0030000000",
    durationMs: 999,
    replayOfRequestId: s.sourceRequestId,
    responseBody: '{"content":[{"type":"text","text":"replay answer"}]}',
    ...overrides,
  });
  const runId = await seedRun(db, {
    orgId: s.org.id,
    sourceRequestId: s.sourceRequestId,
    triggeredBy: s.owner.id,
    status: "ok",
    replayRequestId,
    fidelity: { ...SEEDED_FIDELITY },
  });
  return { runId, replayRequestId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("replay.getComparison", () => {
  it("原請求有 cache_read_tokens 時，延遲與成本標為不可比", async () => {
    const s = await seedScenario(t.db, { cacheReadTokens: 4096 });
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.comparable.latency).toBe(false);
    expect(res.comparable.cost).toBe(false);
    expect(res.source.cacheReadTokens).toBe(4096);
  });

  it("原請求冷、但重放命中快取時，成本一樣不可比（規則是雙向的）", async () => {
    // Reachable through this very feature: `buildReplayBody` only overrides
    // `model` and `stream`, so the source's cache_control markers replay
    // verbatim. Pressing the same-model baseline twice inside the cache TTL
    // gives replay #2 a cache read that replay #1 wrote — with the source
    // still cold. A source-only rule would print both $ figures side by side
    // and call them comparable.
    const s = await seedScenario(t.db, { cacheReadTokens: 0 });
    const { runId } = await seedCompletedRun(t.db, s, {
      cacheReadTokens: 8192,
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.source.cacheReadTokens).toBe(0);
    expect(res.replay!.cacheReadTokens).toBe(8192);
    expect(res.comparable.cost).toBe(false);
    expect(res.comparable.latency).toBe(false);
  });

  it("原請求無 cache read 時成本可比，但延遲仍不可比（重放強制關串流）", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.comparable.cost).toBe(true);
    expect(res.comparable.latency).toBe(false);
  });

  it("完成的 run 回傳兩側解密後的 response body 與指標", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("ok");
    expect(res.source).toMatchObject({
      model: "claude-sonnet-4-5",
      upstreamModel: "claude-sonnet-4-5-20250929",
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 4321,
    });
    expect(res.source.responseBody).toEqual({
      content: [{ type: "text", text: "source answer" }],
    });
    expect(res.replay).toMatchObject({
      model: "claude-haiku-4-5",
      upstreamModel: "claude-haiku-4-5-20251001",
      inputTokens: 101,
      outputTokens: 55,
      durationMs: 999,
    });
    expect(res.replay!.responseBody).toEqual({
      content: [{ type: "text", text: "replay answer" }],
    });
    expect(res.fidelity).toMatchObject(SEEDED_FIDELITY);
  });

  it("尚未完成時 replay 為 null，status 反映實際進度", async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "queued",
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.replay).toBeNull();
    expect(res.status).toBe("queued");
    expect(res.failureReason).toBeNull();
  });

  it("失敗的 run 回傳 failureReason 供 UI 直接顯示", async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "failed",
      failureReason: "truncated_not_replayable",
      fidelity: { ...SEEDED_FIDELITY },
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("failed");
    expect(res.failureReason).toBe("truncated_not_replayable");
    expect(res.replay).toBeNull();
  });

  it("無權限者 → FORBIDDEN（讀對照等同讀解密內容）", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.otherMember.id });

    await expect(
      caller.replay.getComparison({ orgId: s.org.id, runId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("API 未設定 CREDENTIAL_ENCRYPTION_KEY 時回 PRECONDITION_FAILED 而非崩潰", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      env: { ...defaultTestEnv, CREDENTIAL_ENCRYPTION_KEY: undefined },
    });

    await expect(
      caller.replay.getComparison({ orgId: s.org.id, runId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  // ── Stale claim ────────────────────────────────────────────────────────────
  // apps/gateway's claim (`queued → running`) is deliberately one-way and has
  // NO sweeper: a worker crash mid-run strands the row at `running` forever.
  // Rendering that as "still working" would be a permanent lie, so a
  // sufficiently old `running` row reads as failed here.

  it(`一個超過 ${REPLAY_STALE_RUNNING_MS}ms 仍停在 running 的 run 視為失敗`, async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "running",
      createdAt: new Date(Date.now() - REPLAY_STALE_RUNNING_MS - 60_000),
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("failed");
    expect(res.failureReason).toBe(STALE_RUNNING_FAILURE_REASON);
    // The row itself is untouched — this endpoint is a read, and the claim
    // fence must stay one-way (a rewritten row could be re-claimed and billed
    // a second time).
    const [row] = await t.db
      .select({ status: replayRuns.status })
      .from(replayRuns)
      .where(eq(replayRuns.id, runId));
    expect(row!.status).toBe("running");
  });

  it("仍在時限內的 running run 照實回報進行中", async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "running",
      createdAt: new Date(Date.now() - 5_000),
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("running");
    expect(res.failureReason).toBeNull();
  });

  it("狀態值無法辨識時回報 failed，而不是把未知狀態直接吐給頁面", async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "queued",
    });
    // `replay_runs.status` is a plain text column, so nothing at the database
    // level stops a future (or downgraded) writer from putting something else
    // there. The page must degrade to "did not finish", not crash.
    await t.db
      .update(replayRuns)
      .set({ status: "cancelled" })
      .where(eq(replayRuns.id, runId));
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("failed");
    expect(res.failureReason).toBe(UNKNOWN_STATUS_FAILURE_REASON);
  });

  // ── Boundaries ─────────────────────────────────────────────────────────────

  it("ENABLE_EVALUATOR=false 時整個功能隱藏 → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({
      db: t.db,
      userId: s.owner.id,
      env: { ...defaultTestEnv, ENABLE_EVALUATOR: false },
    });

    await expect(
      caller.replay.getComparison({ orgId: s.org.id, runId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("另一個 org 的 run → NOT_FOUND（與不存在無法區分）", async () => {
    const a = await seedScenario(t.db);
    const b = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, a);
    const caller = await callerFor({ db: t.db, userId: b.admin.id });

    await expect(
      caller.replay.getComparison({ orgId: b.org.id, runId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("不存在的 runId → NOT_FOUND", async () => {
    const s = await seedScenario(t.db);
    const caller = await callerFor({ db: t.db, userId: s.admin.id });

    await expect(
      caller.replay.getComparison({
        orgId: s.org.id,
        runId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("org_admin 可讀他人請求的對照", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.admin.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });
    expect(res.status).toBe("ok");
  });

  // ── Degraded content ───────────────────────────────────────────────────────

  it("body 解不開時 responseBody 為 null，其餘指標照常回傳", async () => {
    const s = await seedScenario(t.db, { corruptBody: true });
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.source.responseBody).toBeNull();
    expect(res.source.inputTokens).toBe(100);
    expect(res.replay!.responseBody).not.toBeNull();
  });

  it("原請求的 body 已被保存期限清除時 responseBody 為 null", async () => {
    const s = await seedScenario(t.db, { withBody: false });
    const { runId } = await seedCompletedRun(t.db, s);
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.source.responseBody).toBeNull();
    expect(res.status).toBe("ok");
  });

  it("status 為 ok 但重放的 usage_logs 尚未落地時 replay 為 null（不假裝有結果）", async () => {
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "ok",
      // The gateway writes `ok` as soon as the loopback returns; the replay's
      // own usage_logs row lands later via a separate async queue. Freshly
      // created, so this also pins that the missing-result bound below does
      // NOT fire during the normal short window.
      replayRequestId: randomUUID(),
      fidelity: { ...SEEDED_FIDELITY },
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("ok");
    expect(res.replay).toBeNull();
    expect(res.failureReason).toBeNull();
  });

  it("ok 但結果始終沒落地，超過時限後回報 result_missing（不是無止境的整理中）", async () => {
    // The other half of the "never resolves" hazard: without this bound the
    // page shows 「用量資料整理中…」 and re-queries every few seconds forever.
    const s = await seedScenario(t.db);
    const runId = await seedRun(t.db, {
      orgId: s.org.id,
      sourceRequestId: s.sourceRequestId,
      triggeredBy: s.owner.id,
      status: "ok",
      replayRequestId: randomUUID(),
      fidelity: { ...SEEDED_FIDELITY },
      createdAt: new Date(Date.now() - REPLAY_STALE_RUNNING_MS - 60_000),
    });
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("failed");
    expect(res.failureReason).toBe(RESULT_MISSING_FAILURE_REASON);
    expect(res.replay).toBeNull();
    // Read-only, exactly like the stale-running rule: the stored row keeps
    // saying `ok`, because the replay really did run and really did cost
    // money. Only the reading is downgraded.
    const [row] = await t.db
      .select({ status: replayRuns.status })
      .from(replayRuns)
      .where(eq(replayRuns.id, runId));
    expect(row!.status).toBe("ok");
  });

  it("結果已落地的舊 run 不會被誤判為 result_missing", async () => {
    const s = await seedScenario(t.db);
    const { runId } = await seedCompletedRun(t.db, s);
    await t.db
      .update(replayRuns)
      .set({
        createdAt: new Date(Date.now() - REPLAY_STALE_RUNNING_MS - 60_000),
      })
      .where(eq(replayRuns.id, runId));
    const caller = await callerFor({ db: t.db, userId: s.owner.id });

    const res = await caller.replay.getComparison({
      orgId: s.org.id,
      runId,
    });

    expect(res.status).toBe("ok");
    expect(res.failureReason).toBeNull();
    expect(res.replay).not.toBeNull();
  });
});
