/**
 * 單筆重放主流程（Task 6, single-request-replay）。
 *
 * 讀出一筆被擷取的歷史請求，只把 `model` 換成目標模型（外加強制 stream:false），
 * 以 org eval key 打回 gateway 自己的 `/v1/messages`，再把結果寫回 `replay_runs`。
 *
 * 兩個不可退讓的性質：
 *
 *  1. **不吞解密錯誤。** evaluator 的 `safeDecrypt`（runRuleBased.ts）在解密失敗時
 *     回傳空字串，好讓單一壞掉的 blob 不至於毀掉整份報告。重放照抄就會變成「真的
 *     送出一次空白 prompt 並計費」，所以這裡直接呼叫 `decryptBody`，失敗即
 *     `decrypt_failed`。
 *
 *  2. **每一條路徑都寫回 `replay_runs`。** 所有 return 都經過同一個 `finish()`，
 *     沒有任何分支能忘記收尾。靜默略過會讓該列永遠卡在 `running`，UI 也就永遠
 *     顯示不出任何結果。
 *
 * 另外：`buildReplayBody` 回傳的是**淺層** spread，`tools` / `messages` /
 * `metadata` 與解密出來的原物件是同一份參照。本檔案自解密到 `JSON.stringify`
 * 之間一律把兩者視為唯讀——就地改動任一巢狀欄位會污染記憶體中的原始 body，
 * 進而毀掉同一筆請求的下一次重放。
 */

import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  organizations,
  replayRuns,
  requestBodies,
  upstreamAccounts,
  usageLogs,
} from "@caliber/db";
import type { ReplayJobPayload } from "@caliber/queue";
import { decryptBody } from "../../capture/encrypt.js";
import { EVAL_PIN_HEADER } from "../../runtime/evalAccountPin.js";
import { REPLAY_OF_HEADER } from "../../runtime/replayOfHeader.js";
import { LLM_KEY_REDIS_PREFIX } from "../evaluator/runLlm.js";
import { buildReplayBody } from "./buildReplayBody.js";
import { resolveFidelity, type Fidelity } from "./resolveFidelity.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * `failure_reason` 的完整列舉。`upstream_error` 會再附上 status code
 * （`upstream_error:503`），其餘一律原樣寫入。
 */
export const REPLAY_FAILURE_REASONS = [
  "truncated_not_replayable",
  "body_missing",
  "retention_expired",
  "decrypt_failed",
  "eval_key_unavailable",
  "upstream_error",
  "missing_request_id",
] as const;

export type ReplayFailureReason = (typeof REPLAY_FAILURE_REASONS)[number];

/** 只取所需的 log 介面，`app.log` 與 pino logger 皆結構相容。 */
export interface ReplayLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface RunReplayInput {
  db: Database;
  redis: Redis;
  masterKeyHex: string;
  /** 例如 "http://localhost:3002"——重放打回 gateway 自己。 */
  gatewayBaseUrl: string;
  payload: ReplayJobPayload;
  /** 測試注入用；預設為全域 fetch。 */
  fetchImpl?: typeof fetch;
  logger?: ReplayLogger;
}

interface FinishFields {
  failureReason?: string;
  replayRequestId?: string;
  fidelity?: Fidelity;
}

// ── Main flow ────────────────────────────────────────────────────────────────

/**
 * 執行一次重放。結果一律寫回 `replay_runs`，永遠不回傳值、也不對呼叫端丟出
 * 預期內的失敗——BullMQ 重試無法讓一筆被截斷的 body 變得可重放。
 */
export async function runReplay(input: RunReplayInput): Promise<void> {
  const { db, payload } = input;
  const fetchFn = input.fetchImpl ?? fetch;

  const finish = async (
    status: "ok" | "failed",
    fields: FinishFields = {},
  ): Promise<void> => {
    await db
      .update(replayRuns)
      .set({
        status,
        failureReason: fields.failureReason ?? null,
        replayRequestId: fields.replayRequestId ?? null,
        fidelity: fields.fidelity ?? null,
        completedAt: new Date(),
      })
      .where(eq(replayRuns.id, payload.runId));
  };

  // 1. 認領（claim）：`queued → running` 的單一 UPDATE 就是這次執行的閘門。
  //
  //    這道 `status = 'queued'` 條件不是裝飾。BullMQ 是 at-least-once：
  //    `DEFAULT_JOB_OPTIONS.attempts = 3` 會在 handler 拋錯時重送，行程在
  //    fetch 途中被重啟（例如一次部署）也會被 stalled-job 偵測重送。
  //    `enqueueReplay` 用裸 runId 當 jobId 只擋得住重複「入列」，擋不住重送。
  //    少了這道閘門，重送會把一列已經 `ok` 的紀錄翻回 `running` 並再打一次真實
  //    的計費請求——使用者按一次按鈕卻付兩次錢，而且 `replay_request_id` 只會
  //    留下最後一次，前一次的花費完全沒有痕跡。
  //
  //    單一 UPDATE 會鎖住該列，並行的第二個 writer 看到的就不再是 `queued`，
  //    所以這是一道真正的 single-writer fence。
  //
  //    代價是：若 `finish()` 的寫入本身失敗，該列會停在 `running`，重送也不會
  //    再跑。寧可留下一列需要人工重觸發的紀錄，也不要重複計費。
  const claimed = await db
    .update(replayRuns)
    .set({ status: "running" })
    .where(
      and(
        eq(replayRuns.id, payload.runId),
        eq(replayRuns.orgId, payload.orgId),
        eq(replayRuns.status, "queued"),
      ),
    )
    .returning({ id: replayRuns.id });

  if (claimed.length === 0) {
    // 沒認領到有兩種可能：該列不存在，或已被認領／已結束。多讀一次狀態才能把
    // 兩者記清楚——這條路徑很罕見，而「靜默不做事」正是本功能要避免的缺陷。
    const existing = await db
      .select({ status: replayRuns.status })
      .from(replayRuns)
      .where(eq(replayRuns.id, payload.runId))
      .limit(1)
      .then((r) => r[0]);

    input.logger?.warn(
      {
        runId: payload.runId,
        orgId: payload.orgId,
        currentStatus: existing?.status ?? null,
      },
      existing
        ? "replay: run already claimed or finished — skipping to avoid a second billed replay"
        : "replay: replay_runs row not found — nothing to update",
    );
    return;
  }

  // 2. 讀原始請求。單筆查詢用原表 `usage_logs`（`usage_logs_scored` view 只用於
  //    「某人某期間做了什麼」這類聚合）。
  //
  //    leftJoin 上游帳號是為了誠實記錄「原本那個帳號是否還在」，判準是
  //    `deleted_at IS NULL`——upstream_accounts 走的是軟刪除（schema 的每個
  //    partial index 與 apps/api 的每支查詢都以此為準），而
  //    `usage_logs.account_id` 是 ON DELETE RESTRICT，實體列永遠不會消失。
  //    只判斷「join 有沒有拿到列」會讓這個旗標恆為 true，等於永遠揭露不了它
  //    存在的目的。
  const source = await db
    .select({
      requestBodySealed: requestBodies.requestBodySealed,
      toolResultTruncated: requestBodies.toolResultTruncated,
      bodyTruncated: requestBodies.bodyTruncated,
      retentionUntil: requestBodies.retentionUntil,
      cacheReadTokens: usageLogs.cacheReadTokens,
      accountId: usageLogs.accountId,
      joinedAccountId: upstreamAccounts.id,
      accountDeletedAt: upstreamAccounts.deletedAt,
    })
    .from(requestBodies)
    .innerJoin(usageLogs, eq(usageLogs.requestId, requestBodies.requestId))
    .leftJoin(upstreamAccounts, eq(upstreamAccounts.id, usageLogs.accountId))
    .where(
      and(
        eq(requestBodies.requestId, payload.sourceRequestId),
        eq(usageLogs.orgId, payload.orgId),
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!source) {
    await finish("failed", { failureReason: "body_missing" });
    return;
  }

  if (source.retentionUntil.getTime() < Date.now()) {
    await finish("failed", { failureReason: "retention_expired" });
    return;
  }

  // 3. 保真度閘門。不可重放者到此為止——絕不呼叫 upstream，也就不會花到錢。
  const { replayable, failureReason, fidelity } = resolveFidelity({
    bodyTruncated: source.bodyTruncated,
    toolResultTruncated: source.toolResultTruncated,
    cacheReadTokens: source.cacheReadTokens,
    accountId: source.accountId,
    // 「還在」= 列還在 **且** 未被軟刪除。少了前半段，一列真的消失時
    // `accountDeletedAt` 同樣是 null，會反過來回報「還在」。
    accountStillExists:
      source.joinedAccountId !== null && source.accountDeletedAt === null,
  });

  if (!replayable) {
    // fidelity 一併寫入，UI 才說得出「為什麼不能重放」。
    await finish("failed", { failureReason, fidelity });
    return;
  }

  // 4-5. 解密 → 解析 → 轉換。三者共用一個 guard：AES-GCM 是帶認證的，能解密卻
  //      無法解析成 JSON 物件，代表存下來的 blob 已經壞到無法產生可重放的 body，
  //      與解密失敗在結果上沒有差別；`failure_reason` 是封閉列舉，故一律寫
  //      `decrypt_failed`，真正的錯誤訊息記在 log 供維運區分。
  let replayBody: Record<string, unknown>;
  try {
    const plaintext = decryptBody({
      masterKeyHex: input.masterKeyHex,
      requestId: payload.sourceRequestId,
      sealed: source.requestBodySealed,
    });
    replayBody = buildReplayBody(JSON.parse(plaintext), payload.targetModel);
  } catch (err) {
    input.logger?.warn(
      {
        runId: payload.runId,
        sourceRequestId: payload.sourceRequestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "replay: could not recover a replayable request body",
    );
    await finish("failed", { failureReason: "decrypt_failed", fidelity });
    return;
  }

  // 6. org eval key。重放以系統金鑰認證，故 usage_logs 會掛在該金鑰而非按下
  //    按鈕的人身上——真正的 attribution 記在 `replay_runs.triggered_by`。
  const rawKey = await input.redis.get(
    `${LLM_KEY_REDIS_PREFIX}${payload.orgId}`,
  );
  if (!rawKey) {
    await finish("failed", { failureReason: "eval_key_unavailable", fidelity });
    return;
  }

  const orgRow = await db
    .select({ llmEvalAccountId: organizations.llmEvalAccountId })
    .from(organizations)
    .where(eq(organizations.id, payload.orgId))
    .limit(1)
    .then((r) => r[0]);

  // 7. 打回 gateway 自己。`REPLAY_OF_HEADER` 只有 eval key 前綴的請求會被信任，
  //    它讓這筆重放在 `usage_logs_scored` 中被排除，不會污染任何人的評分。
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${rawKey}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    [REPLAY_OF_HEADER]: payload.sourceRequestId,
  };
  const headers: Record<string, string> = orgRow?.llmEvalAccountId
    ? { ...baseHeaders, [EVAL_PIN_HEADER]: orgRow.llmEvalAccountId }
    : baseHeaders;

  const url = `${input.gatewayBaseUrl.replace(/\/$/, "")}/v1/messages`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      // replayBody 及其巢狀欄位到此為止都未被改動過（見檔頭第 3 點）。
      body: JSON.stringify(replayBody),
    });
  } catch (err) {
    input.logger?.warn(
      {
        runId: payload.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "replay: loopback fetch failed",
    );
    await finish("failed", { failureReason: "upstream_error", fidelity });
    return;
  }

  // 8. 非 2xx。附上 status code，維運才分得出 429 與 500。
  if (!res.ok) {
    // 只記 status，不記 body：上游錯誤內容可能回傳部分原始 prompt。
    input.logger?.warn(
      { runId: payload.runId, status: res.status },
      "replay: loopback returned non-2xx",
    );
    await releaseBody(res);
    await finish("failed", {
      failureReason: `upstream_error:${res.status}`,
      fidelity,
    });
    return;
  }

  // 9. 相關 id。缺少就必須大聲失敗：沒有 `x-request-id` 就沒有辦法把這次重放的
  //    usage_logs / request_bodies 找回來，對照頁會是空的。本專案曾因 evaluator
  //    在 `if (!requestId)` 靜默 return 而丟光每一份 LLM 報告（v0.27.3 修）。
  // `Headers.get` is case-insensitive per the fetch spec, so one lookup covers
  // every casing the gateway might emit.
  const replayRequestId = res.headers.get("x-request-id")?.trim() ?? "";

  await releaseBody(res);

  if (!replayRequestId) {
    input.logger?.warn(
      { runId: payload.runId },
      "replay: loopback response carried no x-request-id — replay is unrecoverable",
    );
    await finish("failed", { failureReason: "missing_request_id", fidelity });
    return;
  }

  // 10. 成功。
  await finish("ok", { replayRequestId, fidelity });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 丟掉回應內容並釋放底層連線。重放的輸出稍後是靠 `replay_request_id` 從
 * `request_bodies` 讀回來的，這裡不需要它；未消費的 body 會把 undici 的連線
 * 一直佔著。純屬清理，失敗與否都不影響重放結果，故不改寫 `replay_runs`。
 */
async function releaseBody(res: Response): Promise<void> {
  try {
    if (res.body && !res.bodyUsed) await res.body.cancel();
  } catch {
    // 連線清理是 best-effort，不值得讓一次成功的重放被記成失敗。
  }
}
