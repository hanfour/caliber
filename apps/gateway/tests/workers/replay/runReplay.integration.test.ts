/**
 * Integration tests for `runReplay` (Task 6, single-request-replay).
 *
 * Stands up a real Postgres testcontainer (same shape as
 * `tests/workers/evaluator/runRuleBased.integration.test.ts`). Redis is
 * ioredis-mock — `runReplay` only ever does a single `GET` against it, so a
 * second container would buy nothing. The upstream is an injected `fetchImpl`
 * stub, so no test ever makes a real network call or spends real money.
 *
 * The contract under test: EVERY path writes back to `replay_runs`. A replay
 * that silently does nothing leaves a row stuck at `running` forever and the
 * UI has nothing to show — that is the defect these tests exist to prevent.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  apiKeys,
  organizations,
  replayRuns,
  requestBodies,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { encryptBody } from "../../../src/capture/encrypt.js";
import { EVAL_PIN_HEADER } from "../../../src/runtime/evalAccountPin.js";
import { REPLAY_OF_HEADER } from "../../../src/runtime/replayOfHeader.js";
import { runReplay } from "../../../src/workers/replay/runReplay.js";
import { LLM_KEY_REDIS_PREFIX } from "../../../src/workers/evaluator/runLlm.js";
import type { Fidelity } from "../../../src/workers/replay/resolveFidelity.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GATEWAY_BASE_URL = "http://gw.test";
const TARGET_MODEL = "claude-sonnet-5";
const EVAL_KEY = "caliber-eval-raw-key-for-tests";

/** The original captured request body every fixture seeds, unless overridden. */
const ORIGINAL_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: true,
  system: "You are terse.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [{ name: "grep", input_schema: { type: "object" } }],
  metadata: { user_id: "u-1" },
};

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;
let redis: Redis;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "run-replay-test-org", name: "Run Replay Test Org" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "run-replay-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "replay-test-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-run-replay-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "rpl-test",
      name: "run-replay-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE replay_runs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db
    .update(organizations)
    .set({ llmEvalAccountId: null })
    .where(eq(organizations.id, orgId));
  // The shared upstream account is soft-deleted by one test below; un-delete it
  // so the others see a live account.
  await db
    .update(upstreamAccounts)
    .set({ deletedAt: null })
    .where(eq(upstreamAccounts.id, accountId));

  redis = new RedisMock() as unknown as Redis;
  await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, EVAL_KEY);
});

afterEach(() => {
  // One RedisMock per test keeps the eval-key fixture isolated; disconnecting
  // stops each instance's listeners accumulating on the shared emitter.
  redis.disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface SeedCapturedRequestOptions {
  bodyTruncated?: boolean;
  toolResultTruncated?: boolean;
  cacheReadTokens?: number;
  retentionUntil?: Date;
  /** Skip the request_bodies row entirely (usage_logs row still written). */
  skipBody?: boolean;
  /** Overwrite the sealed blob with undecryptable bytes. */
  corruptSealed?: boolean;
  /** Override the plaintext request body that gets sealed. */
  body?: unknown;
}

async function seedCapturedRequest(
  opts: SeedCapturedRequestOptions = {},
): Promise<{ requestId: string; orgId: string }> {
  const requestId = `src-req-${randomUUID()}`;

  await db.insert(usageLogs).values({
    requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: true,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: opts.cacheReadTokens ?? 0,
    statusCode: 200,
    durationMs: 1000,
  });

  if (!opts.skipBody) {
    const sealedReq = encryptBody({
      masterKeyHex: TEST_MASTER_KEY,
      requestId,
      plaintext: JSON.stringify(opts.body ?? ORIGINAL_BODY),
    }).sealed;
    const sealedRes = encryptBody({
      masterKeyHex: TEST_MASTER_KEY,
      requestId,
      plaintext: JSON.stringify({ content: [] }),
    }).sealed;

    await db.insert(requestBodies).values({
      requestId,
      orgId,
      // A 64-byte run of garbage is long enough to pass the length guard in
      // decryptBody but fails the AES-GCM auth tag — exactly what a corrupted
      // or wrong-key blob looks like.
      requestBodySealed: opts.corruptSealed ? Buffer.alloc(64, 7) : sealedReq,
      responseBodySealed: sealedRes,
      toolResultTruncated: opts.toolResultTruncated ?? false,
      bodyTruncated: opts.bodyTruncated ?? false,
      retentionUntil:
        opts.retentionUntil ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
  }

  return { requestId, orgId };
}

async function seedReplayRun(args: {
  sourceRequestId: string;
  targetModel?: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(replayRuns)
    .values({
      orgId,
      sourceRequestId: args.sourceRequestId,
      targetModel: args.targetModel ?? TARGET_MODEL,
      triggeredBy: userId,
      status: "queued",
    })
    .returning({ id: replayRuns.id });
  return { id: row!.id };
}

function readRun(runId: string) {
  return db
    .select()
    .from(replayRuns)
    .where(eq(replayRuns.id, runId))
    .then((r) => r[0]!);
}

/** A 200 response carrying the `x-request-id` the gateway always emits. */
function okResponse(requestId = "replay-req-1"): Response {
  return new Response(JSON.stringify({ content: [] }), {
    status: 200,
    headers: { "x-request-id": requestId },
  });
}

/**
 * A `db` stand-in that delegates to the real one, but makes `.update()` throw
 * while `shouldFail()` holds — at most `maxFailures` times. Lets a test inject
 * a failure at an exact point in the flow (e.g. only once the upstream call has
 * been made). Methods are bound to the real instance so drizzle's private
 * fields still resolve through the proxy.
 *
 * `maxFailures` matters for the post-spend test: if *every* update failed, a
 * rollback that should not be there would also fail, and the assertion would
 * pass for the wrong reason. Failing exactly once lets any subsequent write
 * succeed, so the test proves the rollback is genuinely absent.
 */
function dbFailingUpdatesWhen(
  shouldFail: () => boolean,
  maxFailures = Number.POSITIVE_INFINITY,
): Database {
  let failures = 0;
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "update" && shouldFail() && failures < maxFailures) {
        failures += 1;
        return () => {
          throw new Error("db down");
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

function invoke(args: {
  runId: string;
  sourceRequestId: string;
  fetchImpl: typeof fetch;
  targetModel?: string;
  db?: Database;
  redis?: Redis;
}): Promise<void> {
  return runReplay({
    db: args.db ?? db,
    redis: args.redis ?? redis,
    masterKeyHex: TEST_MASTER_KEY,
    gatewayBaseUrl: GATEWAY_BASE_URL,
    payload: {
      runId: args.runId,
      orgId,
      sourceRequestId: args.sourceRequestId,
      targetModel: args.targetModel ?? TARGET_MODEL,
    },
    fetchImpl: args.fetchImpl,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runReplay", () => {
  it("成功路徑：寫回 ok、replay_request_id 與 fidelity", async () => {
    const src = await seedCapturedRequest({ cacheReadTokens: 100 });
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => okResponse(),
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("ok");
    expect(row.failureReason).toBeNull();
    expect(row.replayRequestId).toBe("replay-req-1");
    const fidelity = row.fidelity as Fidelity;
    expect(fidelity.streamingDisabled).toBe(true);
    expect(fidelity.originalCacheReadTokens).toBe(100);
    expect(fidelity.originalAccountId).toBe(accountId);
    expect(fidelity.originalAccountStillExists).toBe(true);
    expect(row.completedAt).not.toBeNull();
  });

  it("原上游帳號已被軟刪除 → fidelity 記為不存在（仍可重放）", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    // 帳號是軟刪除的（deleted_at），且 usage_logs.account_id 是 ON DELETE
    // RESTRICT——實體列永遠還在。只看「join 得到列」會讓這個旗標恆為 true，
    // 也就永遠揭露不了它存在的目的：原本那個上游帳號已經不在了。
    await db
      .update(upstreamAccounts)
      .set({ deletedAt: new Date() })
      .where(eq(upstreamAccounts.id, accountId));

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => okResponse(),
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("ok");
    expect((row.fidelity as Fidelity).originalAccountStillExists).toBe(false);
    expect((row.fidelity as Fidelity).originalAccountId).toBe(accountId);
  });

  it("body_truncated → failed/truncated_not_replayable，且完全不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({ bodyTruncated: true });
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    const fetchImpl = vi.fn();

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("truncated_not_replayable");
    expect(row.replayRequestId).toBeNull();
    expect(row.completedAt).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // 沒花到錢
  });

  it("request_bodies 不存在 → failed/body_missing，且不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({ skipBody: true });
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    const fetchImpl = vi.fn();

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("body_missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retention_until 已過期 → failed/retention_expired，且不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({
      retentionUntil: new Date(Date.now() - 60_000),
    });
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    const fetchImpl = vi.fn();

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("retention_expired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("解密失敗 → failed/decrypt_failed，絕不以空 body 重放", async () => {
    const src = await seedCapturedRequest({ corruptSealed: true });
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    const fetchImpl = vi.fn();

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("decrypt_failed");
    // 這是本測試的重點：evaluator 的 safeDecrypt 會回傳空字串，若照抄就會真的
    // 送出一次「空白 prompt」的計費重放。
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Redis 中無 eval key → failed/eval_key_unavailable，且不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    await redis.del(`${LLM_KEY_REDIS_PREFIX}${orgId}`);
    const fetchImpl = vi.fn();

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("eval_key_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("upstream 非 2xx → failed/upstream_error 並附上 status code", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => new Response("upstream said no", { status: 503 }),
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("upstream_error:503");
    expect(row.replayRequestId).toBeNull();
  });

  it("fetch 直接拋錯 → failed/upstream_error", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("upstream_error");
  });

  it("回應缺 x-request-id → failed/missing_request_id（不得靜默丟棄）", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("missing_request_id");
    expect(row.replayRequestId).toBeNull();
  });

  it("x-request-id 只有空白時視同缺少 → failed/missing_request_id", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () =>
        new Response("{}", { status: 200, headers: { "x-request-id": "   " } }),
    });

    const row = await readRun(run.id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("missing_request_id");
    // 空白 id 若被存下，對照頁會拿它去查 usage_logs 卻永遠查不到。
    expect(row.replayRequestId).toBeNull();
  });

  it("送出的 body 只改 model 與 stream，並帶上 x-caliber-replay-of", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    let sent: {
      url: string;
      body: string;
      headers: Record<string, string>;
    } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      sent = {
        url: String(url),
        body: String(init?.body ?? ""),
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return okResponse();
    };

    await invoke({ runId: run.id, sourceRequestId: src.requestId, fetchImpl });

    expect(sent).not.toBeNull();
    const captured = sent as unknown as {
      url: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(captured.url).toBe(`${GATEWAY_BASE_URL}/v1/messages`);

    const parsed = JSON.parse(captured.body) as Record<string, unknown>;
    expect(parsed.model).toBe(TARGET_MODEL);
    expect(parsed.stream).toBe(false);
    // 除了 model 與 stream，其餘欄位必須與原 body 逐一相同——唯一變因是模型，
    // 否則差異無法歸因。
    const { model: _m, stream: _s, ...restOfReplay } = parsed;
    const {
      model: _om,
      stream: _os,
      ...restOfOriginal
    } = ORIGINAL_BODY as Record<string, unknown>;
    expect(restOfReplay).toEqual(restOfOriginal);
    expect(Object.keys(parsed).sort()).toEqual(
      Object.keys(ORIGINAL_BODY).sort(),
    );

    expect(captured.headers[REPLAY_OF_HEADER]).toBe(src.requestId);
    expect(captured.headers.Authorization).toBe(`Bearer ${EVAL_KEY}`);
    expect(captured.headers[EVAL_PIN_HEADER]).toBeUndefined();
  });

  it("org 設定 llm_eval_account_id 時帶上 eval pin header", async () => {
    await db
      .update(organizations)
      .set({ llmEvalAccountId: accountId })
      .where(eq(organizations.id, orgId));

    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    let headers: Record<string, string> = {};
    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return okResponse();
      },
    });

    expect(headers[EVAL_PIN_HEADER]).toBe(accountId);
  });

  // BullMQ 是 at-least-once：`attempts: 3` 會在 job handler 拋錯時重送，行程在
  // fetch 途中被重啟也會觸發 stalled-job 重送。`enqueueReplay` 的 jobId 去重只
  // 擋得住重複「入列」，擋不住重送。少了 claim 閘門，一次按鈕就會付兩次錢。
  it("已完成的 run 被重送時不重跑，也不會再花一次錢", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => okResponse("replay-req-first"),
    });
    expect((await readRun(run.id)).status).toBe("ok");

    const secondFetch = vi.fn();
    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: secondFetch as unknown as typeof fetch,
    });

    expect(secondFetch).not.toHaveBeenCalled();
    const row = await readRun(run.id);
    expect(row.status).toBe("ok");
    expect(row.replayRequestId).toBe("replay-req-first");
  });

  it("已在 running 的 run 被重送時不重跑（行程重啟後的 stalled 重送）", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    await db
      .update(replayRuns)
      .set({ status: "running" })
      .where(eq(replayRuns.id, run.id));

    const fetchImpl = vi.fn();
    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await readRun(run.id)).status).toBe("running");
  });

  // claim 閘門的存在是為了「不要付兩次錢」，所以它的作用範圍必須剛好等於花錢的
  // 窗口。花錢**之前**的暫時性故障（Postgres/Redis 抽風）本來就該讓 BullMQ 重試
  // 成功；若也被閘門擋住，該列會永遠停在 running 且 failure_reason 是 NULL——
  // 正好就是設計上禁止的「靜默不做事」，只是換了個位置發生。
  it("花錢前的暫時性故障會把 claim 還回去，讓 BullMQ 重試能重新認領", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });
    const fetchImpl = vi.fn();

    // Redis 故障發生在 eval key 查詢，也就是 fetch 之前。
    const brokenRedis = {
      get: async () => {
        throw new Error("redis down");
      },
    } as unknown as Redis;

    await expect(
      invoke({
        runId: run.id,
        sourceRequestId: src.requestId,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        redis: brokenRedis,
      }),
    ).rejects.toThrow("redis down");

    expect(fetchImpl).not.toHaveBeenCalled(); // 沒花到錢
    const afterThrow = await readRun(run.id);
    expect(afterThrow.status).toBe("queued");
    expect(afterThrow.failureReason).toBeNull();
    expect(afterThrow.completedAt).toBeNull();

    // 而且重試真的能重新認領並跑完——不只是欄位被改回去而已。
    await invoke({
      runId: run.id,
      sourceRequestId: src.requestId,
      fetchImpl: async () => okResponse("replay-after-retry"),
    });

    const afterRetry = await readRun(run.id);
    expect(afterRetry.status).toBe("ok");
    expect(afterRetry.replayRequestId).toBe("replay-after-retry");
  });

  it("花錢後的故障仍然停在 running，不還回 claim（寧可卡住也不重複計費）", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId });

    let spent = false;
    // 只有在 upstream 已被呼叫（= 已計費）之後才讓 UPDATE 壞掉，模擬 finish()
    // 寫入失敗。此時絕不能把狀態還原成 queued，否則重試會再付一次錢。
    //
    // 只壞「一次」是刻意的：若之後真的多了一個不該有的 rollback，它會寫成功並
    // 把該列變回 queued，本測試就會失敗。若讓每次 UPDATE 都壞，那個 rollback
    // 也會失敗，該列照樣停在 running——測試就會因為錯誤的理由而通過。
    const flakyDb = dbFailingUpdatesWhen(() => spent, 1);

    await expect(
      invoke({
        runId: run.id,
        sourceRequestId: src.requestId,
        db: flakyDb,
        fetchImpl: async () => {
          spent = true;
          return okResponse();
        },
      }),
    ).rejects.toThrow("db down");

    const row = await readRun(run.id);
    expect(row.status).toBe("running");
    expect(row.replayRequestId).toBeNull();
  });

  it("replay_runs 該列不存在時不丟例外、也不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({});
    const fetchImpl = vi.fn();

    await expect(
      invoke({
        runId: randomUUID(),
        sourceRequestId: src.requestId,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
