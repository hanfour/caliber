# 單筆請求重放（Replay）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 operator 挑出歷史上任一筆 gateway 請求，換一個模型重跑，左右對照結果——且重放流量絕不污染任何成員的評分。

**Architecture:** API 端負責權限檢查與入列，gateway worker 負責解密與執行（因為只有 gateway 保證持有 `CREDENTIAL_ENCRYPTION_KEY`）。重放走真實的 gateway loopback `/v1/messages`，用 org eval key 認證；標記透過防偽 header `x-caliber-replay-of` 傳遞，評分側改讀一個排除重放的 view。

**Tech Stack:** TypeScript / Fastify（gateway）/ tRPC + Next.js App Router（api + web）/ Drizzle ORM + Postgres / BullMQ + Redis / Vitest / Playwright

**Spec:** `docs/superpowers/specs/2026-08-03-single-request-replay-design.md`

## Global Constraints

- **Migration 編號為 `0034`。** 前一支是 `0033_llm_usage_request_id`。必須同時提供 `0034_replay_runs.sql` 與 `0034_down.sql`，並在 `packages/db/drizzle/meta/_journal.json` 補上 `{"idx": 34, "version": "7", "when": 1783699000005, "tag": "0034_replay_runs", "breakpoints": true}`。
- **SQL 檔中每條敘述之間以 `--> statement-breakpoint` 分隔**（drizzle 慣例，見 0033）。
- **BullMQ jobId 不得含冒號。** v0.17.1 曾因 colon jobId 造成 evaluator 入列失效。一律用裸 uuid。
- **不得新增 workspace package。** 共用佇列放進既有的 `@caliber/queue`（`packages/queue/src/`）。新增 package 需要 3 處硬編碼註冊（ci.yml build filters、3× Dockerfile COPY、app package.json），本計畫刻意避開。
- **無 `console.log`。** gateway 用 `req.log` / `app.log`，worker 用注入的 logger。
- **不可變更新。** 一律 spread 產生新物件，不就地修改。
- **重放強制 `stream: false`。**
- **重放只能覆寫 `model` 與 `stream` 兩欄**，其餘 request body 欄位逐欄相同。
- 測試指令一律用 `pnpm --filter <pkg> exec vitest run <path>`；integration 用 `pnpm --filter <pkg> test:integration`。

## File Structure

**新建**

| 檔案 | 責任 |
|---|---|
| `packages/db/src/schema/replayRuns.ts` | `replay_runs` 表定義 |
| `packages/db/src/schema/usageLogsScored.ts` | `usage_logs_scored` view 的 drizzle 定義 |
| `packages/db/drizzle/0034_replay_runs.sql` / `0034_down.sql` | migration |
| `packages/queue/src/replay.ts` | 重放佇列常數、payload schema、factory、enqueue |
| `apps/gateway/src/runtime/replayOfHeader.ts` | `x-caliber-replay-of` 防偽讀取 |
| `apps/gateway/src/workers/replay/resolveFidelity.ts` | 保真度判定（純函式） |
| `apps/gateway/src/workers/replay/buildReplayBody.ts` | 只覆寫 model/stream 的 body 轉換（純函式） |
| `apps/gateway/src/workers/replay/runReplay.ts` | 重放主流程 |
| `apps/gateway/src/workers/replay/worker.ts` | BullMQ worker factory |
| `apps/api/src/trpc/routers/replay.ts` | `enqueue` / `get` / `listForRequest` |
| `apps/web/src/app/dashboard/organizations/[id]/requests/page.tsx` | 請求清單頁 |
| `apps/web/src/app/dashboard/organizations/[id]/requests/[requestId]/page.tsx` | 對照頁 |

**修改**

| 檔案 | 修改內容 |
|---|---|
| `packages/db/src/schema/usageLogs.ts` | 新增 `replayOfRequestId` 欄 |
| `packages/db/src/schema/index.ts` | 匯出兩個新 schema 檔 |
| `packages/queue/src/index.ts` | 匯出 `./replay.js` |
| `apps/gateway/src/runtime/usageLogging.ts` | 把 `replayOfRequestId` 串進 payload |
| `apps/gateway/src/workers/usageLogQueue.ts` | payload schema 新增欄位 |
| `apps/gateway/src/workers/writeUsageLogBatch.ts` | 寫入新欄位 |
| `apps/gateway/src/server.ts` | 註冊 replay queue + worker |
| `packages/auth/src/rbac/actions.ts` / `check.ts` | 新增 `request.replay` 權限 |
| `apps/api/src/trpc/router.ts` | 掛上 `replay` router |
| 評分側 8 處（見 Task 2） | `usageLogs` → `usageLogsScored` |

**純函式優先：** `resolveFidelity` 與 `buildReplayBody` 刻意抽成無 IO 的純函式，讓最關鍵的兩條規則（截斷必須擋、只能改兩欄）能用不碰 DB 的快速單元測試鎖死。

---

### Task 1: Schema、migration 與 view

**Files:**
- Create: `packages/db/src/schema/replayRuns.ts`
- Create: `packages/db/src/schema/usageLogsScored.ts`
- Create: `packages/db/drizzle/0034_replay_runs.sql`
- Create: `packages/db/drizzle/0034_down.sql`
- Modify: `packages/db/src/schema/usageLogs.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `packages/db/tests/replayRuns.integration.test.ts`

**Interfaces:**
- Produces: `replayRuns`（drizzle table）、`usageLogsScored`（drizzle view）、`usageLogs.replayOfRequestId`（`text`, nullable）。後續所有 task 依賴這三者的欄位名。

- [ ] **Step 1: 寫失敗的 integration 測試**

建立 `packages/db/tests/replayRuns.integration.test.ts`。此測試需要真實 Postgres——沿用本 package 既有 integration 測試的 container 起法（開檔前先看同目錄任一 `*.integration.test.ts` 如何取得 `db`，照抄其 setup）。

```typescript
import { describe, it, expect } from "vitest";
import { isNull } from "drizzle-orm";
import { replayRuns, usageLogs, usageLogsScored } from "../src/schema/index.js";

describe("replay schema", () => {
  it("usage_logs_scored 濾掉帶 replay_of_request_id 的列", async () => {
    // seed：一筆正常請求 + 一筆重放請求（欄位以既有 factory 產生）
    const normal = await seedUsageLog({ replayOfRequestId: null });
    const replay = await seedUsageLog({ replayOfRequestId: normal.requestId });

    const rawIds = (await db.select().from(usageLogs)).map((r) => r.requestId);
    const scoredIds = (await db.select().from(usageLogsScored)).map((r) => r.requestId);

    expect(rawIds).toContain(replay.requestId);
    expect(scoredIds).toContain(normal.requestId);
    expect(scoredIds).not.toContain(replay.requestId);
  });

  it("replay_runs 可插入並以 source_request_id 查回", async () => {
    const src = await seedUsageLog({ replayOfRequestId: null });
    await db.insert(replayRuns).values({
      orgId: src.orgId,
      sourceRequestId: src.requestId,
      targetModel: "claude-sonnet-5",
      triggeredBy: src.userId,
      status: "queued",
    });
    const rows = await db.select().from(replayRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("queued");
    expect(rows[0].replayRequestId).toBeNull();
  });
});
```

`seedUsageLog` 請沿用 `apps/gateway/tests/factories` 同等慣例；若 `packages/db/tests` 無現成 factory，於本檔內就地寫一個最小 helper，插入 `usage_logs` 所有 NOT NULL 欄位。

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/db test:integration`
Expected: FAIL — `replayRuns` / `usageLogsScored` 不存在（TypeScript 解析即錯）。

- [ ] **Step 3: 新增 `replayRuns` schema**

`packages/db/src/schema/replayRuns.ts`：

```typescript
import { pgTable, text, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";
import { usageLogs } from "./usageLogs.js";

/**
 * 單筆重放的一次執行。`triggered_by` 是真正的 attribution——重放本身以 org
 * eval key 認證，usage_logs 會掛在那把系統金鑰上而非按下按鈕的人身上。
 */
export const replayRuns = pgTable(
  "replay_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceRequestId: text("source_request_id")
      .notNull()
      .references(() => usageLogs.requestId, { onDelete: "cascade" }),
    // 重放產生的 usage_logs.request_id；失敗時維持 null。
    replayRequestId: text("replay_request_id"),
    targetModel: text("target_model").notNull(),
    triggeredBy: uuid("triggered_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // queued | running | ok | failed
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    fidelity: jsonb("fidelity"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    orgTimeIdx: index("replay_runs_org_time_idx").on(t.orgId, t.createdAt),
    sourceIdx: index("replay_runs_source_idx").on(t.sourceRequestId),
  }),
);
```

- [ ] **Step 4: 在 `usageLogs` 新增欄位**

於 `packages/db/src/schema/usageLogs.ts`，在 `deviceId` 與 `createdAt` 之間插入：

```typescript
    // 非 null 表示這是一筆重放，值為被重放的原始 request_id。評分側一律透過
    // `usage_logs_scored` view 排除；成本側讀原表並獨立顯示。
    replayOfRequestId: text("replay_of_request_id"),
```

並在該表的 index 物件中加入：

```typescript
    replayIdx: index("usage_logs_replay_idx").on(t.replayOfRequestId),
```

- [ ] **Step 5: 新增 `usageLogsScored` view**

`packages/db/src/schema/usageLogsScored.ts`：

```typescript
import { pgView } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";
import { usageLogs } from "./usageLogs.js";

/**
 * 評分側唯一該讀的來源。重放流量在此被排除，使得「忘記加 WHERE」不再可能
 * 造成考績被灌分——新寫的評分程式碼沿用慣例即自動安全。
 *
 * 定義必須與 packages/db/drizzle/0034_replay_runs.sql 中手寫的 CREATE VIEW
 * 完全一致。本專案的 migration 是手寫的，不跑 drizzle-kit generate。
 */
export const usageLogsScored = pgView("usage_logs_scored").as((qb) =>
  qb.select().from(usageLogs).where(isNull(usageLogs.replayOfRequestId)),
);
```

- [ ] **Step 6: 匯出兩個新 schema**

於 `packages/db/src/schema/index.ts` 的 `export * from "./usageLogs.js";` 之後加入：

```typescript
export * from "./usageLogsScored.js";
export * from "./replayRuns.js";
```

- [ ] **Step 7: 寫 migration**

`packages/db/drizzle/0034_replay_runs.sql`：

```sql
-- 0034_replay_runs.sql
-- 單筆請求重放。`replay_of_request_id` 標記重放流量；`usage_logs_scored`
-- 讓評分側預設看不到它——在 14 個查詢點各補 WHERE 是「今天做對、半年後被新
-- 程式碼默默破壞」的解法，而破壞的形式是某人的考績多了幾分，不會有人察覺。
ALTER TABLE "usage_logs" ADD COLUMN "replay_of_request_id" text;
--> statement-breakpoint
-- partial index：非重放列（絕大多數）不佔索引空間。
CREATE INDEX "usage_logs_replay_idx" ON "usage_logs" ("replay_of_request_id")
  WHERE "replay_of_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE VIEW "usage_logs_scored" AS
  SELECT * FROM "usage_logs" WHERE "replay_of_request_id" IS NULL;
--> statement-breakpoint
CREATE TABLE "replay_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "source_request_id" text NOT NULL REFERENCES "usage_logs"("request_id") ON DELETE cascade,
  "replay_request_id" text,
  "target_model" text NOT NULL,
  "triggered_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "status" text DEFAULT 'queued' NOT NULL,
  "failure_reason" text,
  "fidelity" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "replay_runs_org_time_idx" ON "replay_runs" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "replay_runs_source_idx" ON "replay_runs" ("source_request_id");
```

`packages/db/drizzle/0034_down.sql`：

```sql
-- 0034_down.sql — reverse of 0034_replay_runs.sql
DROP TABLE IF EXISTS "replay_runs";
--> statement-breakpoint
DROP VIEW IF EXISTS "usage_logs_scored";
--> statement-breakpoint
DROP INDEX IF EXISTS "usage_logs_replay_idx";
--> statement-breakpoint
-- 有損：重放列在 rollback 後與一般流量無法區分，會重新計入評分。
-- 若曾實際執行過重放，rollback 前應先 DELETE FROM usage_logs
-- WHERE replay_of_request_id IS NOT NULL。
ALTER TABLE "usage_logs" DROP COLUMN IF EXISTS "replay_of_request_id";
```

- [ ] **Step 8: 補 journal**

於 `packages/db/drizzle/meta/_journal.json` 的 `entries` 陣列尾端，`0033` 之後加入：

```json
    {
      "idx": 34,
      "version": "7",
      "when": 1783699000005,
      "tag": "0034_replay_runs",
      "breakpoints": true
    }
```

- [ ] **Step 9: 執行測試確認通過**

Run: `pnpm --filter @caliber/db test:integration`
Expected: PASS（兩個測試皆綠）

- [ ] **Step 10: 型別檢查**

Run: `pnpm --filter @caliber/db exec tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/schema/replayRuns.ts \
        packages/db/src/schema/usageLogsScored.ts \
        packages/db/src/schema/usageLogs.ts \
        packages/db/src/schema/index.ts \
        packages/db/drizzle/0034_replay_runs.sql \
        packages/db/drizzle/0034_down.sql \
        packages/db/drizzle/meta/_journal.json \
        packages/db/tests/replayRuns.integration.test.ts
git commit -m "feat(db): replay_runs table, replay_of_request_id column, usage_logs_scored view"
```

---

### Task 2: 污染防治——聚合型評分查詢改讀 view

這是整份計畫最重要的一項，且**必須在任何重放流量能被產生之前完成**。

**判準（背下來，不要逐案思考）：** 查的是「這個人這段期間做了什麼」→ 用 `usageLogsScored`；查的是「這一筆花了多少錢」→ 用 `usageLogs` 原表。

**Files:**
- Modify: `apps/api/src/trpc/routers/rubrics.ts:484`
- Modify: `apps/api/src/services/facetSummary.ts:72`
- Modify: `apps/gateway/src/workers/evaluator/runRuleBased.ts:119`
- Modify: `apps/gateway/src/workers/evaluator/cron.ts:178`
- Test: `apps/gateway/tests/workers/evaluator/replayExclusion.integration.test.ts`

**明確不動（改了會壞）：**

| 檔案 | 為何不動 |
|---|---|
| `apps/gateway/src/workers/evaluator/runLlm.ts:182` | `WHERE requestId = <該次 LLM 呼叫>` 回填成本；改讀 view 會讓成本永遠查不回來 |
| `apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts:242` | 同上，ledger 回填 |
| `apps/gateway/src/workers/githubDelivery/runDeliveryQuality.ts:393` | 同上（`pollUsageLogCost`） |
| `apps/api/src/trpc/routers/reports.ts:767` | GDPR `exportOwn`，資料可攜需完整 |
| `apps/api/src/trpc/routers/usage.ts`（6 處） | 成本側，Task 9 另行加上獨立顯示 |

**Interfaces:**
- Consumes: Task 1 的 `usageLogsScored`
- Produces: 無新介面；本 task 的產出是「重放不影響分數」這條性質，由測試固定。

- [ ] **Step 1: 寫失敗的回歸測試（本功能真正的防線）**

建立 `apps/gateway/tests/workers/evaluator/replayExclusion.integration.test.ts`。開檔前先讀 `apps/gateway/tests/workers/evaluator/runRuleBased.integration.test.ts`，照抄其 DB 與 fixture 起法。

```typescript
import { describe, it, expect } from "vitest";
import { runRuleBased } from "../../../src/workers/evaluator/runRuleBased.js";

describe("replay 不得影響評分", () => {
  it("加入一筆 replay usage_log 後，規則分數完全不變", async () => {
    // 1. 以既有 fixture 建一個有若干正常請求的成員
    const ctx = await seedScorableMember();

    const before = await runRuleBased({ ...ctx.runInput });

    // 2. 插入一筆重放列——同 user、同期間、同模型，唯一差別是被標記為重放
    await seedUsageLog({
      orgId: ctx.orgId,
      userId: ctx.userId,
      createdAt: ctx.windowMiddle,
      replayOfRequestId: ctx.anyExistingRequestId,
    });

    const after = await runRuleBased({ ...ctx.runInput });

    // 3. 分數必須逐項相同——不是「接近」，是相同
    expect(after.totalScore).toBe(before.totalScore);
    expect(after.signals).toEqual(before.signals);
  });
});
```

若 `runRuleBased` 的回傳欄位名與此不同，以實際型別為準；重點是斷言**整份報告的評分部分逐欄相等**。

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/gateway test:integration -- replayExclusion`
Expected: FAIL — `after.totalScore` 因多出一筆請求而與 `before` 不同。

**這一步不可跳過。** 若測試在改 code 前就通過，代表 fixture 沒真的把重放列餵進評分窗，測試是假的——回頭修 fixture。

- [ ] **Step 3: 改 `runRuleBased.ts:119`**

匯入改為由 `@caliber/db` 取 `usageLogsScored`，並將該查詢的 `.from(usageLogs)` 換成 `.from(usageLogsScored)`。所有 `usageLogs.<欄位>` 的引用同步改為 `usageLogsScored.<欄位>`。於查詢上方加註：

```typescript
    // 讀 usage_logs_scored 而非 usage_logs：重放流量不得計入任何人的分數。
    // 判準——「這個人這段期間做了什麼」用 view，「這一筆花多少錢」用原表。
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @caliber/gateway test:integration -- replayExclusion`
Expected: PASS

- [ ] **Step 5: 以相同方式改其餘三處**

`apps/gateway/src/workers/evaluator/cron.ts:178`、`apps/api/src/trpc/routers/rubrics.ts:484`、`apps/api/src/services/facetSummary.ts:72`——同樣換 `.from(...)` / `.innerJoin(...)` 的目標與欄位引用，並加上同一段註解。

`facetSummary.ts:72` 是 `innerJoin`，改為：

```typescript
    .innerJoin(usageLogsScored, eq(requestBodyFacets.requestId, usageLogsScored.requestId))
```

其 `.where()` 中的 `usageLogs.userId` / `usageLogs.createdAt` 一併改為 `usageLogsScored.*`。

- [ ] **Step 6: 全域確認沒有漏改的聚合查詢**

Run:
```bash
grep -rn "from(usageLogs)\|innerJoin(usageLogs\|leftJoin(usageLogs" --include="*.ts" apps packages | grep -v dist | grep -v test
```
Expected: 只剩下 4 個「明確不動」清單中的檔案，加上 `apps/api/src/trpc/routers/usage.ts` 的 6 處。逐行核對，任何不在清單上的新結果都必須先分類再決定。

- [ ] **Step 7: 跑完整測試套件確認沒弄壞既有評分**

Run: `pnpm --filter @caliber/gateway test:integration` 與 `pnpm --filter @caliber/api exec vitest run`
Expected: 全綠。**任一既有評分測試變紅，代表換錯了地方**——回頭比對「明確不動」清單。

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/workers/evaluator/runRuleBased.ts \
        apps/gateway/src/workers/evaluator/cron.ts \
        apps/api/src/trpc/routers/rubrics.ts \
        apps/api/src/services/facetSummary.ts \
        apps/gateway/tests/workers/evaluator/replayExclusion.integration.test.ts
git commit -m "feat(evaluator): read usage_logs_scored in aggregate scoring queries"
```

---

### Task 3: `x-caliber-replay-of` 防偽 header 與 usage log 串接

**這是整份設計最嚴重的潛在漏洞所在。** 若此 header 可被偽造，任何持有 api key 的成員都能把自己的請求標記為重放，讓它從評分中消失。

解法沿用既有模式，不需發明：`apps/gateway/src/runtime/evalAccountPin.ts` 已經解過同一題——header **只在請求以 eval key（`keyPrefix === "caliber-eval"`）認證時才被信任**，而 eval key 的 raw 值只存在於 gateway 內部 Redis，外部 client 無從取得。

**Files:**
- Create: `apps/gateway/src/runtime/replayOfHeader.ts`
- Modify: `apps/gateway/src/workers/usageLogQueue.ts:75`（payload schema）
- Modify: `apps/gateway/src/workers/writeUsageLogBatch.ts:56`（insert values）
- Modify: `apps/gateway/src/runtime/usageLogging.ts`（payload 組裝，約 345 行）
- Test: `apps/gateway/tests/runtime/replayOfHeader.test.ts`

**Interfaces:**
- Produces: `REPLAY_OF_HEADER = "x-caliber-replay-of"`、`replayOfHeader(req): string | undefined`、`UsageLogJobPayload.replayOfRequestId: string | null`

- [ ] **Step 1: 寫失敗的單元測試**

`apps/gateway/tests/runtime/replayOfHeader.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { replayOfHeader, REPLAY_OF_HEADER } from "../../src/runtime/replayOfHeader.js";

function req(opts: { keyPrefix?: string; header?: string }) {
  return {
    apiKey: opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : null,
    headers: opts.header ? { [REPLAY_OF_HEADER]: opts.header } : {},
  };
}

describe("replayOfHeader", () => {
  it("以 eval key 認證時信任 header", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval", header: "req-123" }))).toBe("req-123");
  });

  it("以一般成員 key 認證時丟棄 header（防偽核心）", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber", header: "req-123" }))).toBeUndefined();
  });

  it("未認證時丟棄 header", () => {
    expect(replayOfHeader(req({ header: "req-123" }))).toBeUndefined();
  });

  it("eval key 但無 header → undefined", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval" }))).toBeUndefined();
  });

  it("header 為空字串 → undefined（不得寫入空字串）", () => {
    expect(replayOfHeader(req({ keyPrefix: "caliber-eval", header: "" }))).toBeUndefined();
  });

  it("header 重複出現時取第一個", () => {
    const r = {
      apiKey: { keyPrefix: "caliber-eval" },
      headers: { [REPLAY_OF_HEADER]: ["req-a", "req-b"] },
    };
    expect(replayOfHeader(r)).toBe("req-a");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/replayOfHeader.test.ts`
Expected: FAIL — 模組不存在。

- [ ] **Step 3: 實作 helper**

`apps/gateway/src/runtime/replayOfHeader.ts`：

```typescript
// Reads the internal replay-marker header, but ONLY trusts it when the request
// authenticated with an eval key (keyPrefix "caliber-eval"). Eval keys' raw
// values exist only in gateway-internal Redis, so an external client cannot
// hold one — making the prefix a sufficient anti-forgery gate.
//
// Why this matters more than the eval pin it mirrors: a forged replay marker
// removes the request from `usage_logs_scored`, i.e. it lets a member hide
// their own traffic from scoring. Never widen the trust condition here.

export const REPLAY_OF_HEADER = "x-caliber-replay-of";
const EVAL_KEY_PREFIX = "caliber-eval";

export function replayOfHeader(req: {
  apiKey?: { keyPrefix?: string } | null;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  if (req.apiKey?.keyPrefix !== EVAL_KEY_PREFIX) return undefined;
  const raw = req.headers[REPLAY_OF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || undefined;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/runtime/replayOfHeader.test.ts`
Expected: PASS（6 項全綠）

- [ ] **Step 5: 擴充 payload schema**

於 `apps/gateway/src/workers/usageLogQueue.ts` 的 `UsageLogJobPayload`（第 75 行起的 `z.object({...})`）中，`deviceId` 附近加入：

```typescript
  // 非 null 表示這是重放產生的請求，值為被重放的原始 request_id。
  // 只可能來自 replayOfHeader()，已通過 eval-key 前綴防偽閘門。
  replayOfRequestId: z.string().nullable().default(null),
```

- [ ] **Step 6: 寫入 DB**

於 `apps/gateway/src/workers/writeUsageLogBatch.ts` 的 `payloads.map((p) => ({...}))` 中，`deviceId: p.deviceId` 附近加入：

```typescript
          replayOfRequestId: p.replayOfRequestId,
```

- [ ] **Step 7: 串進 payload 組裝**

於 `apps/gateway/src/runtime/usageLogging.ts`，先在檔案頂端 import：

```typescript
import { replayOfHeader } from "./replayOfHeader.js";
```

再於 `buildUsageLogPayload` 內組 `payload` 物件處（約 345 行，`deviceId` 欄位附近）加入：

```typescript
    replayOfRequestId: replayOfHeader(input.req) ?? null,
```

- [ ] **Step 8: 寫 end-to-end 防偽 integration 測試**

於 `apps/gateway/tests/integration/` 下新增 `replayMarkerForgery.integration.test.ts`。照抄同目錄既有測試的 server 起法，發兩次請求：

```typescript
it("一般成員 key 帶 x-caliber-replay-of 時，該欄位必須為 null（照常計入評分）", async () => {
  await postMessages({
    apiKey: memberKey,                       // 一般成員金鑰
    headers: { "x-caliber-replay-of": "req-victim" },
  });
  const row = await db.select().from(usageLogs)
    .where(eq(usageLogs.apiKeyId, memberKey.id)).limit(1).then((r) => r[0]);
  expect(row.replayOfRequestId).toBeNull();
});
```

- [ ] **Step 9: 執行全部測試**

Run: `pnpm --filter @caliber/gateway exec vitest run` 與 `pnpm --filter @caliber/gateway test:integration`
Expected: 全綠

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/runtime/replayOfHeader.ts \
        apps/gateway/src/runtime/usageLogging.ts \
        apps/gateway/src/workers/usageLogQueue.ts \
        apps/gateway/src/workers/writeUsageLogBatch.ts \
        apps/gateway/tests/runtime/replayOfHeader.test.ts \
        apps/gateway/tests/integration/replayMarkerForgery.integration.test.ts
git commit -m "feat(gateway): anti-forgery x-caliber-replay-of header wired into usage logs"
```

---

### Task 4: 共用重放佇列（`@caliber/queue`）

放在 `packages/queue` 而非 gateway 內，因為 **API 端入列、gateway 端消費**，兩邊都要用到常數與 payload schema。**不得為此新增 workspace package**（會需要 3 處硬編碼註冊）。

**Files:**
- Create: `packages/queue/src/replay.ts`
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/tests/replay.test.ts`

**Interfaces:**
- Produces: `REPLAY_QUEUE_NAME`、`REPLAY_JOB_NAME`、`ReplayJobPayload`（zod + type）、`createReplayQueue(opts)`、`enqueueReplay(queue, payload): Promise<{ jobId: string }>`

- [ ] **Step 1: 寫失敗的單元測試**

`packages/queue/tests/replay.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { enqueueReplay, ReplayJobPayload, REPLAY_JOB_NAME } from "../src/replay.js";

const valid = {
  runId: "3f1b7c4e-9a2d-4f77-8b0e-1c2d3e4f5a6b",
  orgId: "0a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d",
  sourceRequestId: "req-abc",
  targetModel: "claude-sonnet-5",
};

describe("enqueueReplay", () => {
  it("以 runId 作為 jobId（裸 uuid，不含冒號）", async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const res = await enqueueReplay(queue, valid);
    expect(res.jobId).toBe(valid.runId);
    expect(res.jobId).not.toContain(":");
    expect(queue.add).toHaveBeenCalledWith(REPLAY_JOB_NAME, valid, { jobId: valid.runId });
  });

  it("payload 不合法時擲錯（視為程式錯誤，非暫時性狀況）", async () => {
    const queue = { add: vi.fn() };
    await expect(enqueueReplay(queue, { ...valid, targetModel: "" })).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("schema 拒絕缺少 sourceRequestId 的 payload", () => {
    const { sourceRequestId: _drop, ...bad } = valid;
    expect(() => ReplayJobPayload.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/queue exec vitest run tests/replay.test.ts`
Expected: FAIL — 模組不存在。

- [ ] **Step 3: 實作佇列模組**

`packages/queue/src/replay.ts`（結構對照 `packages/queue/src/evaluator.ts`，沿用其 `buildQueueOptions` / `QueueLike` / `CALIBER_QUEUE_PREFIX` / `DEFAULT_JOB_OPTIONS`，實際名稱以 `shared.ts` 匯出者為準）：

```typescript
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import {
  CALIBER_QUEUE_PREFIX,
  DEFAULT_JOB_OPTIONS,
  type QueueConnection,
  type QueueLike,
} from "./shared.js";

export const REPLAY_QUEUE_NAME = "replay";
export const REPLAY_QUEUE_PREFIX = CALIBER_QUEUE_PREFIX;
export const REPLAY_JOB_NAME = "replay";
export const REPLAY_DEFAULT_JOB_OPTIONS = DEFAULT_JOB_OPTIONS;

export const ReplayJobPayload = z.object({
  /** replay_runs.id — 同時作為 BullMQ jobId。裸 uuid，不含冒號。 */
  runId: z.string().uuid(),
  orgId: z.string().uuid(),
  sourceRequestId: z.string().min(1),
  targetModel: z.string().min(1),
});

export type ReplayJobPayload = z.infer<typeof ReplayJobPayload>;

export interface CreateReplayQueueOptions {
  connection: QueueConnection;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createReplayQueue(
  opts: CreateReplayQueueOptions,
): Queue<ReplayJobPayload> {
  return new Queue<ReplayJobPayload>(REPLAY_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? REPLAY_QUEUE_PREFIX,
    defaultJobOptions: { ...REPLAY_DEFAULT_JOB_OPTIONS, ...opts.defaultJobOptions },
  });
}

export interface EnqueueReplayResult {
  jobId: string;
}

/**
 * jobId 直接用 runId（uuid）。
 *
 * 不得自組含冒號的 jobId——v0.17.1 曾因 colon jobId 造成 evaluator 入列失效。
 * 以 runId 為 id 同時取得 BullMQ 天然的重試去重：同一次 run 的重投不會產生
 * 第二份重放（也就不會重複花錢）。
 */
export async function enqueueReplay(
  queue: QueueLike,
  payload: unknown,
): Promise<EnqueueReplayResult> {
  const validated = ReplayJobPayload.parse(payload);
  await queue.add(REPLAY_JOB_NAME, validated, { jobId: validated.runId });
  return { jobId: validated.runId };
}
```

若 `shared.ts` 實際匯出的名稱與上述不同，以該檔為準，**不要新增重複的常數**。

- [ ] **Step 4: 匯出**

於 `packages/queue/src/index.ts` 末尾加入：

```typescript
export * from "./replay.js";
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter @caliber/queue exec vitest run tests/replay.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/replay.ts packages/queue/src/index.ts packages/queue/tests/replay.test.ts
git commit -m "feat(queue): replay job queue, payload schema and enqueue wrapper"
```

---

### Task 5: 保真度與 body 轉換（純函式）

兩條最關鍵的規則——**截斷必須擋下**、**只能改兩欄**——抽成無 IO 的純函式，用不碰 DB 的快速測試鎖死。

**Files:**
- Create: `apps/gateway/src/workers/replay/resolveFidelity.ts`
- Create: `apps/gateway/src/workers/replay/buildReplayBody.ts`
- Test: `apps/gateway/tests/workers/replay/resolveFidelity.test.ts`
- Test: `apps/gateway/tests/workers/replay/buildReplayBody.test.ts`

**Interfaces:**
- Produces:
  - `resolveFidelity(input): { replayable: boolean; failureReason?: string; fidelity: Fidelity }`
  - `Fidelity = { toolResultTruncated: boolean; originalCacheReadTokens: number; originalAccountId: string | null; originalAccountStillExists: boolean; streamingDisabled: true }`
  - `buildReplayBody(originalBody: unknown, targetModel: string): Record<string, unknown>`

- [ ] **Step 1: 寫失敗的 `resolveFidelity` 測試**

`apps/gateway/tests/workers/replay/resolveFidelity.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { resolveFidelity } from "../../../src/workers/replay/resolveFidelity.js";

const base = {
  bodyTruncated: false,
  toolResultTruncated: false,
  cacheReadTokens: 0,
  accountId: "acc-1",
  accountStillExists: true,
};

describe("resolveFidelity", () => {
  it("body_truncated 一律拒絕重放", () => {
    const r = resolveFidelity({ ...base, bodyTruncated: true });
    expect(r.replayable).toBe(false);
    expect(r.failureReason).toBe("truncated_not_replayable");
  });

  it("tool_result_truncated 允許重放但記錄旗標", () => {
    const r = resolveFidelity({ ...base, toolResultTruncated: true });
    expect(r.replayable).toBe(true);
    expect(r.fidelity.toolResultTruncated).toBe(true);
  });

  it("永遠記錄 streamingDisabled，因為重放強制關閉串流", () => {
    expect(resolveFidelity(base).fidelity.streamingDisabled).toBe(true);
  });

  it("保留原始 cache_read_tokens 供 UI 判斷延遲與成本是否可比", () => {
    const r = resolveFidelity({ ...base, cacheReadTokens: 48213 });
    expect(r.fidelity.originalCacheReadTokens).toBe(48213);
  });

  it("記錄原上游帳號是否仍存在", () => {
    const r = resolveFidelity({ ...base, accountStillExists: false });
    expect(r.replayable).toBe(true);
    expect(r.fidelity.originalAccountStillExists).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/replay/resolveFidelity.test.ts`
Expected: FAIL — 模組不存在。

- [ ] **Step 3: 實作 `resolveFidelity`**

```typescript
export interface Fidelity {
  toolResultTruncated: boolean;
  originalCacheReadTokens: number;
  originalAccountId: string | null;
  originalAccountStillExists: boolean;
  /** 重放一律關閉串流，故延遲數字與原請求不可比。恆為 true。 */
  streamingDisabled: true;
}

export interface ResolveFidelityInput {
  bodyTruncated: boolean;
  toolResultTruncated: boolean;
  cacheReadTokens: number;
  accountId: string | null;
  accountStillExists: boolean;
}

export interface ResolveFidelityResult {
  replayable: boolean;
  failureReason?: string;
  fidelity: Fidelity;
}

/**
 * 判定一筆請求是否可重放，並產出保真度旗標。
 *
 * 只有 body_truncated 是硬性阻擋：body 被截斷代表我們手上的根本不是原始輸入，
 * 重放結果無法歸因於模型，讓它跑只會產出「看起來嚴謹、實際錯誤」的結論。
 * 其餘旗標一律放行但據實記錄，由 UI 揭露給使用者判斷。
 */
export function resolveFidelity(input: ResolveFidelityInput): ResolveFidelityResult {
  const fidelity: Fidelity = {
    toolResultTruncated: input.toolResultTruncated,
    originalCacheReadTokens: input.cacheReadTokens,
    originalAccountId: input.accountId,
    originalAccountStillExists: input.accountStillExists,
    streamingDisabled: true,
  };

  if (input.bodyTruncated) {
    return { replayable: false, failureReason: "truncated_not_replayable", fidelity };
  }
  return { replayable: true, fidelity };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/replay/resolveFidelity.test.ts`
Expected: PASS（5 項全綠）

- [ ] **Step 5: 寫失敗的 `buildReplayBody` 測試**

`apps/gateway/tests/workers/replay/buildReplayBody.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { buildReplayBody } from "../../../src/workers/replay/buildReplayBody.js";

const original = {
  model: "claude-opus-4-5",
  stream: true,
  max_tokens: 4096,
  temperature: 0.7,
  system: "you are helpful",
  tools: [{ name: "grep", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: "u1" },
};

describe("buildReplayBody", () => {
  it("只改 model 與 stream 兩欄，其餘逐欄相同", () => {
    const out = buildReplayBody(original, "claude-sonnet-5");
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.stream).toBe(false);

    const { model: _m1, stream: _s1, ...restIn } = original;
    const { model: _m2, stream: _s2, ...restOut } = out;
    expect(restOut).toEqual(restIn);
  });

  it("不就地修改原物件（不可變）", () => {
    const snapshot = JSON.parse(JSON.stringify(original));
    buildReplayBody(original, "claude-sonnet-5");
    expect(original).toEqual(snapshot);
  });

  it("原 body 沒有 stream 欄位時仍明確補上 false", () => {
    const { stream: _drop, ...noStream } = original;
    expect(buildReplayBody(noStream, "claude-sonnet-5").stream).toBe(false);
  });

  it("原 body 非物件時擲錯", () => {
    expect(() => buildReplayBody("not-an-object", "claude-sonnet-5")).toThrow();
    expect(() => buildReplayBody(null, "claude-sonnet-5")).toThrow();
  });
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/replay/buildReplayBody.test.ts`
Expected: FAIL — 模組不存在。

- [ ] **Step 7: 實作 `buildReplayBody`**

```typescript
/**
 * 產生重放用的 request body：只覆寫 `model` 與 `stream`，其餘原封不動。
 *
 * 唯一變因必須是模型，否則差異無法歸因。強制 stream:false 是為了拿到完整 body
 * 好做比對——代價是延遲數字不可比，該事實由 resolveFidelity 記入 fidelity。
 */
export function buildReplayBody(
  originalBody: unknown,
  targetModel: string,
): Record<string, unknown> {
  if (originalBody === null || typeof originalBody !== "object" || Array.isArray(originalBody)) {
    throw new Error("replay: original request body is not a JSON object");
  }
  return {
    ...(originalBody as Record<string, unknown>),
    model: targetModel,
    stream: false,
  };
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `pnpm --filter @caliber/gateway exec vitest run tests/workers/replay/`
Expected: PASS（9 項全綠）

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/workers/replay/resolveFidelity.ts \
        apps/gateway/src/workers/replay/buildReplayBody.ts \
        apps/gateway/tests/workers/replay/
git commit -m "feat(gateway): replay fidelity gate and model-only body transform"
```

---

### Task 6: 重放主流程與 BullMQ worker

**Files:**
- Create: `apps/gateway/src/workers/replay/runReplay.ts`
- Create: `apps/gateway/src/workers/replay/worker.ts`
- Modify: `apps/gateway/src/server.ts`（約 671 行的 evaluator 區塊之後）
- Test: `apps/gateway/tests/workers/replay/runReplay.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `replayRuns`、Task 4 `ReplayJobPayload` / `REPLAY_QUEUE_NAME`、Task 5 `resolveFidelity` / `buildReplayBody`
- Produces: `runReplay(input): Promise<void>`（結果一律寫回 `replay_runs`，不回傳）、`createReplayWorker(opts)`

**關鍵差異——不要照抄 evaluator 的解密寫法：** `runRuleBased.ts:359` 的 `safeDecrypt` 解密失敗時回傳空字串，讓單一壞掉的 blob 不至於毀掉整份報告。**重放不可沿用此行為**——空 body 會變成一次「重放了空白 prompt」的真實花費。重放必須直接呼叫 `decryptBody` 並在失敗時寫 `decrypt_failed`。

**`failure_reason` 完整列舉：** `truncated_not_replayable`、`body_missing`、`retention_expired`、`decrypt_failed`、`eval_key_unavailable`、`upstream_error`、`missing_request_id`。任一失敗路徑都必須寫入其中之一，**不得靜默略過**。

- [ ] **Step 1: 寫失敗的 integration 測試**

`apps/gateway/tests/workers/replay/runReplay.integration.test.ts`。照抄 `runRuleBased.integration.test.ts` 的 DB 起法；upstream 以注入的 `fetchImpl` stub 掉。

```typescript
describe("runReplay", () => {
  it("成功路徑：寫回 ok、replay_request_id 與 fidelity", async () => {
    const src = await seedCapturedRequest({ bodyTruncated: false, cacheReadTokens: 100 });
    const run = await seedReplayRun({ sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" });

    await runReplay({
      db, masterKeyHex, redis,
      gatewayBaseUrl: "http://gw.test",
      payload: { runId: run.id, orgId: src.orgId, sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" },
      fetchImpl: async () => new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { "x-request-id": "replay-req-1" },
      }),
    });

    const row = await db.select().from(replayRuns).where(eq(replayRuns.id, run.id)).then((r) => r[0]);
    expect(row.status).toBe("ok");
    expect(row.replayRequestId).toBe("replay-req-1");
    expect(row.fidelity.streamingDisabled).toBe(true);
    expect(row.fidelity.originalCacheReadTokens).toBe(100);
    expect(row.completedAt).not.toBeNull();
  });

  it("body_truncated → failed/truncated_not_replayable，且完全不呼叫 upstream", async () => {
    const src = await seedCapturedRequest({ bodyTruncated: true });
    const run = await seedReplayRun({ sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" });
    const fetchImpl = vi.fn();

    await runReplay({ db, masterKeyHex, redis, gatewayBaseUrl: "http://gw.test",
      payload: { runId: run.id, orgId: src.orgId, sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" },
      fetchImpl });

    const row = await db.select().from(replayRuns).where(eq(replayRuns.id, run.id)).then((r) => r[0]);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("truncated_not_replayable");
    expect(fetchImpl).not.toHaveBeenCalled();   // 沒花到錢
  });

  it("回應缺 x-request-id → failed/missing_request_id（不得靜默丟棄）", async () => {
    const src = await seedCapturedRequest({});
    const run = await seedReplayRun({ sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" });

    await runReplay({ db, masterKeyHex, redis, gatewayBaseUrl: "http://gw.test",
      payload: { runId: run.id, orgId: src.orgId, sourceRequestId: src.requestId, targetModel: "claude-sonnet-5" },
      fetchImpl: async () => new Response("{}", { status: 200 }) });

    const row = await db.select().from(replayRuns).where(eq(replayRuns.id, run.id)).then((r) => r[0]);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("missing_request_id");
  });

  it("Redis 中無 eval key → failed/eval_key_unavailable，且不呼叫 upstream", async () => {
    await redis.del(`${LLM_KEY_REDIS_PREFIX}${src.orgId}`);
    // …斷言 status failed / failureReason eval_key_unavailable / fetch 未被呼叫
  });

  it("送出的 body 只改 model 與 stream，並帶上 x-caliber-replay-of", async () => {
    let sent: { body: string; headers: Record<string, string> } | null = null;
    // …以 fetchImpl 捕捉，斷言 JSON.parse(sent.body).model === targetModel、
    //   .stream === false、其餘欄位與原 body 相同、
    //   headers["x-caliber-replay-of"] === src.requestId
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/gateway test:integration -- runReplay`
Expected: FAIL — 模組不存在。

- [ ] **Step 3: 實作 `runReplay.ts`**

流程依序為：

1. 讀 `replay_runs`，寫 `status='running'`
2. `innerJoin` 讀 `request_bodies` + `usage_logs`（此處**用原表**，查的是單筆）。查無 → `body_missing`；`retention_until < now()` → `retention_expired`
3. `resolveFidelity(...)`；`replayable === false` → 寫 `failed` + `failureReason` 後**直接 return，不呼叫 upstream**
4. `decryptBody({ masterKeyHex, requestId: sourceRequestId, sealed: requestBodySealed })`，以 try/catch 包住，失敗 → `decrypt_failed`
5. `JSON.parse` 後交給 `buildReplayBody(body, targetModel)`
6. 自 Redis 取 org eval key（`LLM_KEY_REDIS_PREFIX + orgId`，與 `runLlm.ts:71` 同）；無 → `eval_key_unavailable`
7. `POST ${gatewayBaseUrl}/v1/messages`，headers：

```typescript
const headers: Record<string, string> = {
  Authorization: `Bearer ${rawKey}`,
  "Content-Type": "application/json",
  "anthropic-version": "2023-06-01",
  [REPLAY_OF_HEADER]: payload.sourceRequestId,
};
// org 有設定 llmEvalAccountId 時額外帶上 EVAL_PIN_HEADER（同 runLlm.ts）
```

8. 非 2xx → `upstream_error`（`failure_reason` 附上 status code）
9. 讀回應的 `x-request-id`；缺少 → `missing_request_id`
10. 寫 `status='ok'`、`replayRequestId`、`fidelity`、`completedAt`

每一條失敗路徑都經由同一個 `finish(status, failureReason?)` 區域函式寫回，避免任何一條路徑忘記更新 `replay_runs`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @caliber/gateway test:integration -- runReplay`
Expected: PASS

- [ ] **Step 5: 實作 worker**

`apps/gateway/src/workers/replay/worker.ts`，結構對照 `apps/gateway/src/workers/evaluator/worker.ts`：

```typescript
export function createReplayWorker(opts: CreateReplayWorkerOptions): Worker<ReplayJobPayload, void> {
  return new Worker<ReplayJobPayload, void>(
    REPLAY_QUEUE_NAME,
    async (job) => {
      await runReplay({
        db: opts.db,
        redis: opts.redis,
        masterKeyHex: opts.masterKeyHex,
        gatewayBaseUrl: opts.gatewayBaseUrl,
        payload: job.data,
      });
    },
    { connection: opts.connection, prefix: REPLAY_QUEUE_PREFIX, concurrency: 1 },
  );
}
```

`concurrency: 1` 是刻意的：重放會真的花錢，不需要平行度，序列化也讓速率限制更好推理。

- [ ] **Step 6: 在 server.ts 掛線**

於 `apps/gateway/src/server.ts` 的 evaluator 區塊（約 671 行）之後，沿用該區塊的 `workerRedis` 與 `bullmqRedis`：

```typescript
  const replayQueue = createReplayQueue({ connection: bullmqRedis });
  const replayWorker = createReplayWorker({
    connection: bullmqRedis,
    db: app.db,
    redis: workerRedis,
    masterKeyHex: credentialEncryptionKey,
    gatewayBaseUrl: env.GATEWAY_LOCAL_BASE_URL,
  });
  app.decorate("replayQueue", replayQueue);
```

並在既有的 `app.addHook("onClose", ...)` 中一併關閉 `replayWorker` 與 `replayQueue`（照抄該 hook 內 evaluator 的關閉寫法）。

- [ ] **Step 7: 全套測試**

Run: `pnpm --filter @caliber/gateway exec vitest run` 與 `pnpm --filter @caliber/gateway test:integration`
Expected: 全綠

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/workers/replay/ apps/gateway/src/server.ts apps/gateway/tests/workers/replay/
git commit -m "feat(gateway): replay worker executing model-only loopback replays"
```

---

### Task 7: `request.replay` 權限

重放不只是「讀」——它會**解密他人的 prompt 全文**並且**花真的錢**，因此獨立成一個權限，不搭在既有讀取權之上。

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts:110`（`report.export_own` 附近）
- Modify: `packages/auth/src/rbac/check.ts:242`（同區塊）
- Test: `packages/auth/tests/rbac/requestReplay.test.ts`

**Interfaces:**
- Produces: `{ type: "request.replay"; orgId: string; targetUserId: string }`

- [ ] **Step 1: 寫失敗的測試**

`packages/auth/tests/rbac/requestReplay.test.ts`。開檔前先讀同目錄既有 rbac 測試，照抄其建構 `perm` 物件的 helper。

```typescript
import { describe, it, expect } from "vitest";
import { can } from "../../src/rbac/check.js";

describe("request.replay", () => {
  it("本人可重放自己的請求", () => {
    const perm = permFor({ userId: "u1", roles: [] });
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(true);
  });

  it("org_admin 可重放組織內他人的請求", () => {
    const perm = permFor({ userId: "admin", roles: [{ scope: "organization", id: "o1", role: "org_admin" }] });
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(true);
  });

  it("一般成員不可重放他人的請求", () => {
    const perm = permFor({ userId: "u2", roles: [] });
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(false);
  });

  it("team_manager 不足以重放——需解密他人 prompt 全文，故僅限 org_admin", () => {
    const perm = permFor({ userId: "tm", roles: [{ scope: "team", id: "t1", role: "team_manager" }] });
    expect(can(perm, { type: "request.replay", orgId: "o1", targetUserId: "u1" })).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/auth exec vitest run tests/rbac/requestReplay.test.ts`
Expected: FAIL — action 型別不存在（TypeScript 即報錯）。

- [ ] **Step 3: 新增 action 型別**

於 `packages/auth/src/rbac/actions.ts` 的 `| { type: "report.export_own" }` 之後加入：

```typescript
  | { type: "request.replay"; orgId: string; targetUserId: string }
```

- [ ] **Step 4: 新增判定**

於 `packages/auth/src/rbac/check.ts` 的 `case "report.read_user":` 區塊附近加入：

```typescript
    // 重放會解密他人 prompt 全文且花費真實金額，故不比照 read_user 開放給
    // team_manager——僅限本人與 org_admin。
    case "request.replay":
      if (action.targetUserId === perm.userId) return true;
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter @caliber/auth exec vitest run tests/rbac/requestReplay.test.ts`
Expected: PASS（4 項全綠）

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/rbac/actions.ts packages/auth/src/rbac/check.ts packages/auth/tests/rbac/requestReplay.test.ts
git commit -m "feat(auth): request.replay permission (self or org_admin only)"
```

---

### Task 8: `replay` tRPC router（含速率限制與稽核）

速率限制與 audit 折進本 task，因為它們是同一支 mutation 的契約的一部分——沒有它們，`enqueue` 就是一個可以被連按到燒光預算、且不留痕跡地解密他人內容的端點。

**Files:**
- Create: `apps/api/src/trpc/routers/replay.ts`
- Modify: `apps/api/src/trpc/router.ts:41` 附近
- Test: `apps/api/tests/trpc/replay.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `replayRuns`、Task 4 `enqueueReplay`、Task 7 `request.replay`
- Produces: `replay.enqueue({ orgId, requestId, targetModel }) → { runId }`、`replay.get({ runId })`、`replay.listForRequest({ orgId, requestId })`

- [ ] **Step 1: 寫失敗的 integration 測試**

`apps/api/tests/trpc/replay.integration.test.ts`：

```typescript
describe("replay.enqueue", () => {
  it("非本人非 admin → FORBIDDEN", async () => {
    await expect(
      callerAs(otherMember).replay.enqueue({ orgId, requestId: src.requestId, targetModel: "claude-sonnet-5" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("body_truncated 的請求 → PRECONDITION_FAILED，且不入列（不浪費 worker 也不花錢）", async () => {
    const truncated = await seedCapturedRequest({ bodyTruncated: true });
    await expect(
      callerAs(owner).replay.enqueue({ orgId, requestId: truncated.requestId, targetModel: "claude-sonnet-5" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("成功時寫入 replay_runs(queued) 並入列，jobId 為裸 runId", async () => {
    const res = await callerAs(owner).replay.enqueue({ orgId, requestId: src.requestId, targetModel: "claude-sonnet-5" });
    const row = await db.select().from(replayRuns).where(eq(replayRuns.id, res.runId)).then((r) => r[0]);
    expect(row.status).toBe("queued");
    expect(row.triggeredBy).toBe(owner.id);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: res.runId }));
  });

  it("寫入 audit log", async () => {
    const res = await callerAs(admin).replay.enqueue({ orgId, requestId: src.requestId, targetModel: "claude-sonnet-5" });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "request.replay")).then((r) => r[0]);
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.targetId).toBe(src.requestId);
    expect(audit.metadata).toMatchObject({ runId: res.runId, targetModel: "claude-sonnet-5" });
  });

  it("超過每小時上限 → TOO_MANY_REQUESTS", async () => {
    for (let i = 0; i < REPLAY_HOURLY_LIMIT; i++) {
      await callerAs(owner).replay.enqueue({ orgId, requestId: src.requestId, targetModel: "claude-sonnet-5" });
    }
    await expect(
      callerAs(owner).replay.enqueue({ orgId, requestId: src.requestId, targetModel: "claude-sonnet-5" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/api test:integration -- replay`
Expected: FAIL — router 不存在。

- [ ] **Step 3: 實作 router**

`apps/api/src/trpc/routers/replay.ts` 要點：

- `REPLAY_HOURLY_LIMIT = 20`，匯出供測試使用（**不得硬編在函式內**）
- `enqueue` 依序：
  1. 讀 `usage_logs` + `request_bodies`（原表，單筆查詢）取得 `userId`、`bodyTruncated`、`retentionUntil`
  2. 查無 → `NOT_FOUND`
  3. `can(ctx.perm, { type: "request.replay", orgId, targetUserId: row.userId })`；否 → `FORBIDDEN`
  4. `bodyTruncated` 或 `retentionUntil < now()` → `PRECONDITION_FAILED`，附明確 message。**此預檢是 UX；worker 端的 `resolveFidelity` 才是權威**，兩處都必須存在
  5. 速率限制：以 `ctx.db` 計數該 user 過去 1 小時的 `replay_runs` 列數，`>= REPLAY_HOURLY_LIMIT` → `TOO_MANY_REQUESTS`
  6. 於同一 transaction 內 insert `replay_runs(status='queued')` 並 `writeAudit`
  7. transaction 提交後才 `enqueueReplay`——先落地再入列，worker 才不會撿到還沒 commit 的 run
- `get` / `listForRequest` 同樣做 `request.replay` 權限檢查（讀結果等同讀重放內容）

audit 寫法：

```typescript
await writeAudit(tx, {
  actorUserId: ctx.user.id,
  action: "request.replay",
  targetType: "usage_log",
  targetId: input.requestId,
  orgId: input.orgId,
  metadata: { runId, targetModel: input.targetModel, targetUserId: row.userId },
});
```

- [ ] **Step 4: 掛上 router**

於 `apps/api/src/trpc/router.ts` 的 `githubDelivery: githubDeliveryRouter,` 之後加入 `replay: replayRouter,`，並補 import。

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter @caliber/api test:integration -- replay`
Expected: PASS（5 項全綠）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/replay.ts apps/api/src/trpc/router.ts apps/api/tests/trpc/replay.integration.test.ts
git commit -m "feat(api): replay router with permission, fidelity precheck, rate limit and audit"
```

---

### Task 9: 請求清單查詢與成本側獨立顯示

**這是全計畫唯一沒有 CI 防護的環節**（spec Open risk #1）：view 讓評分側安全，但成本側若沒把重放獨立出來，重放的錢會混進成員成本。code review 必須明確確認本 task 完成。

**Files:**
- Modify: `apps/api/src/trpc/routers/usage.ts`
- Test: `apps/api/tests/trpc/usageListRequests.integration.test.ts`

**Interfaces:**
- Produces: `usage.listRequests({ orgId, userId, from?, to?, limit?, cursor? })` → `{ rows: RequestRow[], nextCursor: string | null }`，其中

```typescript
interface RequestRow {
  requestId: string;
  createdAt: Date;
  requestedModel: string;
  upstreamModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCost: string;
  statusCode: number;
  durationMs: number;
  stopReason: string | null;      // 來自 request_bodies
  bodyTruncated: boolean;         // 來自 request_bodies，決定重放鈕是否 disabled
  toolResultTruncated: boolean;
  hasBody: boolean;               // request_bodies 是否仍在（retention 未過期）
  replayOfRequestId: string | null;
}
```

- [ ] **Step 1: 寫失敗的測試**

```typescript
describe("usage.listRequests", () => {
  it("回傳含 bodyTruncated 與 hasBody 的列，供 UI 決定重放鈕狀態", async () => {
    const rows = (await callerAs(owner).usage.listRequests({ orgId, userId: owner.id })).rows;
    expect(rows[0]).toMatchObject({ bodyTruncated: false, hasBody: true });
  });

  it("retention 已過期（request_bodies 已被清除）的列 hasBody 為 false", async () => {
    // seed 一筆只有 usage_logs、沒有 request_bodies 的請求
    const rows = (await callerAs(owner).usage.listRequests({ orgId, userId: owner.id })).rows;
    expect(rows.find((r) => r.requestId === expiredId)?.hasBody).toBe(false);
  });

  it("重放列以 replayOfRequestId 標示，未被隱藏", async () => {
    const rows = (await callerAs(admin).usage.listRequests({ orgId, userId: evalKeyUserId })).rows;
    expect(rows.some((r) => r.replayOfRequestId !== null)).toBe(true);
  });

  it("非本人非 admin → FORBIDDEN", async () => {
    await expect(callerAs(otherMember).usage.listRequests({ orgId, userId: owner.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("usage 成本彙總", () => {
  it("重放成本獨立成一項，不混入成員成本", async () => {
    const summary = await callerAs(admin).usage.orgSummary({ orgId, from, to });
    expect(summary.replayCostUsd).toBeGreaterThan(0);
    expect(summary.totalCostUsd).toBe(summary.memberCostUsd + summary.replayCostUsd);
  });
});
```

第二個 describe 的實際欄位名以 `usage.ts` 既有彙總回傳型別為準；重點是**重放成本必須是一個獨立且可見的數字**，且與成員成本相加等於總額。

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/api test:integration -- usageListRequests`
Expected: FAIL

- [ ] **Step 3: 實作 `listRequests`**

於 `apps/api/src/trpc/routers/usage.ts` 新增 procedure。查詢**讀原表** `usageLogs`（要看得到重放），`leftJoin` `requestBodies` 取 `stopReason` / `bodyTruncated` / `toolResultTruncated`，`hasBody` 由 join 是否命中決定。權限沿用該檔既有的 `usage.read_user` 判定。游標分頁照抄 `sessions.ts:listForUser` 的 `createdAt` cursor 寫法。

- [ ] **Step 4: 成本彙總加上重放拆分**

於 `usage.ts` 既有的彙總查詢中，新增一個以 `replayOfRequestId IS NOT NULL` 為條件的 `SUM(actual_cost_usd)`，回傳為獨立欄位。**不要**從總額中扣掉——總額仍是真實總支出，只是多一個拆解維度。

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter @caliber/api test:integration -- usage`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/usage.ts apps/api/tests/trpc/usageListRequests.integration.test.ts
git commit -m "feat(api): usage.listRequests plus replay cost broken out in summaries"
```

---

### Task 10: 請求清單頁

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/requests/page.tsx`
- Test: `apps/web/e2e/requests-list.spec.ts`

**Interfaces:**
- Consumes: Task 9 `usage.listRequests`、Task 8 `replay.enqueue`

- [ ] **Step 1: 寫失敗的 E2E**

```typescript
test("清單顯示請求，截斷列的重放鈕 disabled 並說明原因", async ({ page }) => {
  await page.goto(`/dashboard/organizations/${orgSlug}/requests`);
  await expect(page.getByRole("row")).not.toHaveCount(0);

  const truncatedRow = page.getByRole("row", { name: /truncated-fixture/ });
  await expect(truncatedRow.getByRole("button", { name: "重放" })).toBeDisabled();
  await expect(truncatedRow).toContainText("已截斷");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @caliber/web exec playwright test requests-list`
Expected: FAIL — 路由不存在（404）

- [ ] **Step 3: 實作頁面**

照抄 `apps/web/src/app/dashboard/organizations/[id]/sessions/page.tsx` 的結構（`resolveIdentifier` 解 slug → `useQuery`）。表格欄位即 Task 9 的 `RequestRow`。每列一顆「重放」按鈕，開啟一個模型選擇的小型 popover 後呼叫 `replay.enqueue`，成功後導向 `/requests/<requestId>`。

**disabled 條件與提示文字：**

| 條件 | 按鈕 | 提示 |
|---|---|---|
| `bodyTruncated` | disabled | 「此筆內容已截斷，重放結果不可比」 |
| `!hasBody` | disabled | 「已超過保存期限，內容已刪除」 |
| 其餘 | enabled | — |

**在使用者花錢之前就講清楚**，而不是讓它失敗後才顯示原因。

- [ ] **Step 4: 執行確認通過**

Run: `pnpm --filter @caliber/web exec playwright test requests-list`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/dashboard/organizations/\[id\]/requests/page.tsx apps/web/e2e/requests-list.spec.ts
git commit -m "feat(web): gateway request list with replay entry point"
```

---

### Task 11: 解密端點與對照頁

**spec 未交代的缺口，在此補上：** 對照頁要顯示解密後的 body，但 API server **不一定**持有 `CREDENTIAL_ENCRYPTION_KEY`（`reports.ts:733`）。

解法沿用 `apps/api/src/trpc/routers/_credentials.ts:60` 的 `requireMasterKeyHex(env)` 模式：API 在有金鑰時自行解密，無金鑰時以明確錯誤回應，UI 顯示「未設定，無法顯示內容」而非空白或崩潰。本專案的 api 與 gateway 同在一個 compose stack，正式部署本就共用該金鑰；此設計只是讓「沒設定」成為一個誠實可見的狀態。

**Files:**
- Modify: `apps/api/src/trpc/routers/replay.ts`（新增 `getComparison`）
- Create: `apps/web/src/app/dashboard/organizations/[id]/requests/[requestId]/page.tsx`
- Test: `apps/api/tests/trpc/replayComparison.integration.test.ts`
- Test: `apps/web/e2e/replay-comparison.spec.ts`

**Interfaces:**
- Produces: `replay.getComparison({ orgId, runId })` →

```typescript
{
  source: { model: string; upstreamModel: string; responseBody: unknown;
            inputTokens: number; outputTokens: number; cacheReadTokens: number;
            totalCost: string; durationMs: number };
  replay: { model: string; upstreamModel: string; responseBody: unknown;
            inputTokens: number; outputTokens: number; cacheReadTokens: number;
            totalCost: string; durationMs: number } | null;   // 尚未完成或失敗時為 null
  status: "queued" | "running" | "ok" | "failed";
  failureReason: string | null;
  fidelity: Fidelity | null;
  comparable: { latency: boolean; cost: boolean };   // cache 冷熱造成的不可比
}
```

- [ ] **Step 1: 寫失敗的測試**

```typescript
describe("replay.getComparison", () => {
  it("原請求有 cache_read_tokens 時，延遲與成本標為不可比", async () => {
    const res = await callerAs(owner).replay.getComparison({ orgId, runId });
    expect(res.comparable.latency).toBe(false);
    expect(res.comparable.cost).toBe(false);
  });

  it("原請求無 cache read 時成本可比，但延遲仍不可比（重放強制關串流）", async () => {
    const res = await callerAs(owner).replay.getComparison({ orgId, runId: coldRunId });
    expect(res.comparable.cost).toBe(true);
    expect(res.comparable.latency).toBe(false);
  });

  it("尚未完成時 replay 為 null，status 反映實際進度", async () => {
    const res = await callerAs(owner).replay.getComparison({ orgId, runId: queuedRunId });
    expect(res.replay).toBeNull();
    expect(res.status).toBe("queued");
  });

  it("失敗的 run 回傳 failureReason 供 UI 直接顯示", async () => {
    const res = await callerAs(owner).replay.getComparison({ orgId, runId: failedRunId });
    expect(res.status).toBe("failed");
    expect(res.failureReason).toBe("truncated_not_replayable");
  });

  it("無權限者 → FORBIDDEN（讀對照等同讀解密內容）", async () => {
    await expect(callerAs(otherMember).replay.getComparison({ orgId, runId }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("API 未設定 CREDENTIAL_ENCRYPTION_KEY 時回 PRECONDITION_FAILED 而非崩潰", async () => {
    await expect(callerWithoutKey(owner).replay.getComparison({ orgId, runId }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @caliber/api test:integration -- replayComparison`
Expected: FAIL

- [ ] **Step 3: 實作 `getComparison`**

要點：

- 先做 `request.replay` 權限檢查（以 `replay_runs.source_request_id` 反查原請求的 `userId`）
- `requireMasterKeyHex(ctx.env)`——缺金鑰時擲 `PRECONDITION_FAILED`，message 明確指出未設定
- 兩筆 `request_bodies` 各自解密 `responseBodySealed`
- `comparable.latency` **恆為 false**（重放強制關串流）
- `comparable.cost` = 原請求 `cacheReadTokens === 0`
- `status !== "ok"` 時 `replay` 為 `null`，但仍回傳 `status` 與 `failureReason`

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @caliber/api test:integration -- replayComparison`
Expected: PASS（6 項全綠）

- [ ] **Step 5: 寫失敗的對照頁 E2E**

```typescript
test("對照頁並排顯示，保真度警告在內容上方，且提供同模型 baseline", async ({ page }) => {
  await page.goto(`/dashboard/organizations/${orgSlug}/requests/${requestId}`);

  await expect(page.getByTestId("source-response")).toBeVisible();
  await expect(page.getByTestId("replay-response")).toBeVisible();

  // 警告必須在對照內容「上方」，不是頁尾註腳
  const banner = page.getByTestId("fidelity-banner");
  const content = page.getByTestId("comparison-content");
  expect((await banner.boundingBox())!.y).toBeLessThan((await content.boundingBox())!.y);

  await expect(page.getByText("延遲不可比")).toBeVisible();
  await expect(page.getByRole("button", { name: "用同一模型再跑一次" })).toBeEnabled();
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `pnpm --filter @caliber/web exec playwright test replay-comparison`
Expected: FAIL — 路由不存在

- [ ] **Step 7: 實作對照頁**

版面由上而下：

1. **保真度警告橫幅**（`data-testid="fidelity-banner"`）——cache 冷熱、串流已關閉、tool result 已截斷、原上游帳號已不存在。**必須置於對照內容上方**
2. 上方指標列：模型、`upstreamModel`（實際解析結果）、tokens、成本、延遲。`comparable.latency === false` 時，延遲欄顯示「不可比」而非數字；成本同理
3. 並排 response（`data-testid="source-response"` / `"replay-response"`），差異以 diff 標示
4. 「用同一模型再跑一次」按鈕——以 `source.model` 呼叫 `replay.enqueue`。**這是 noise baseline，不是選配**：沒有它，使用者無從判斷差異來自模型換代還是取樣隨機性
5. `status` 為 `queued` / `running` 時輪詢；`failed` 時直接顯示 `failureReason` 對應的中文說明

- [ ] **Step 8: 執行確認通過**

Run: `pnpm --filter @caliber/web exec playwright test replay-comparison`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/trpc/routers/replay.ts \
        apps/web/src/app/dashboard/organizations/\[id\]/requests/\[requestId\]/page.tsx \
        apps/api/tests/trpc/replayComparison.integration.test.ts \
        apps/web/e2e/replay-comparison.spec.ts
git commit -m "feat: replay comparison endpoint and side-by-side page"
```

---

### Task 12: 全鏈路驗證與文件

- [ ] **Step 1: 全套測試**

Run:
```bash
pnpm --filter @caliber/db test:integration
pnpm --filter @caliber/queue exec vitest run
pnpm --filter @caliber/auth exec vitest run
pnpm --filter @caliber/gateway exec vitest run && pnpm --filter @caliber/gateway test:integration
pnpm --filter @caliber/api exec vitest run && pnpm --filter @caliber/api test:integration
pnpm --filter @caliber/web exec playwright test
```
Expected: 全綠

- [ ] **Step 2: 型別檢查全 workspace**

Run: `pnpm -r exec tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: 手動煙霧測試（真實 upstream，會花錢）**

在本機 compose 起完整堆疊後：

1. 打幾筆真實請求產生歷史
2. 開 `/dashboard/organizations/<slug>/requests`，確認清單有列
3. 對一筆按「重放」，選一個不同模型
4. 確認對照頁出現雙欄結果與保真度橫幅
5. 按「用同一模型再跑一次」，確認產生第二次 run
6. **確認該成員的評分未改變**——重放前後各生成一次報告，分數必須相同
7. 確認成本頁的重放成本獨立顯示且不為零

第 6 步是整個功能的驗收核心，不可略過。

- [ ] **Step 4: 更新文件**

於 `docs/EVALUATOR.md` 新增一節說明 `usage_logs_scored` 的存在與判準（「這個人這段期間做了什麼」用 view、「這一筆花多少錢」用原表），讓日後改評分的人不需要重新推導。

- [ ] **Step 5: Commit 並開 PR**

```bash
git add docs/EVALUATOR.md
git commit -m "docs: document usage_logs_scored and the replay exclusion rule"
gh auth switch --user hanfour && gh auth setup-git
git push -u origin feat/single-request-replay
gh pr create --title "feat: 單筆請求重放（model time machine）" --body "$(cat <<'EOF'
## Summary
挑出歷史上任一筆 gateway 請求，換一個模型重跑，左右對照。唯一變因是模型。

## 污染防治
新增 `usage_logs_scored` view；4 支聚合型評分查詢改讀它，4 支單列成本回填維持原表。
`x-caliber-replay-of` 沿用 eval-key 前綴防偽閘門，成員無法自行標記流量躲避評分。

## Test plan
- [ ] 全 workspace 測試綠
- [ ] 重放前後成員分數不變（integration 斷言 + 手動驗證）
- [ ] 一般成員偽造 replay header 無效
- [ ] 成本頁重放金額獨立可見
EOF
)"
```

`gh` 的 active account 每回合會退回無寫入權的帳號，故 push 前必須先 `gh auth switch`。

---

## Self-Review

**Spec 覆蓋**

| Spec 章節 | 對應 Task |
|---|---|
| Component 1 Schema | Task 1 |
| Component 2 污染防治 | Task 2、Task 9（成本側） |
| Component 3 保真度閘門 | Task 5、Task 6、Task 11（UI 揭露） |
| Component 3 noise baseline | Task 11 Step 7 項目 4 |
| Component 4 執行流程 | Task 4、Task 6 |
| Component 4 防偽 header | Task 3 |
| Component 5 UI | Task 10、Task 11 |
| Component 6 權限與稽核 | Task 7、Task 8 |
| Testing | 各 task 內含；Task 12 總驗證 |
| Open risk #1（成本可見性無 CI 防護） | Task 9 開頭明確標註 |

**與 spec 的兩處偏離（已在本計畫內修正 spec）**

1. spec 原稱「評分側 8 處全換 view」。實查後只有 4 處該換；另 4 處是單列成本回填與 GDPR 匯出，**改了會壞**。spec 已同步更新。
2. spec 未交代對照頁如何取得解密內容（API 不一定有 master key）。Task 11 補上 `requireMasterKeyHex` 閘門與「未設定」狀態。

**型別一致性**：`Fidelity` 於 Task 5 定義，Task 6 寫入、Task 11 回傳，欄位名一致。`ReplayJobPayload` 的 `runId`/`orgId`/`sourceRequestId`/`targetModel` 於 Task 4 定義，Task 6、Task 8 沿用。`RequestRow` 於 Task 9 定義，Task 10 消費。

**已知順序約束**：Task 2 必須早於 Task 3——防護要在任何重放流量可被產生之前就位。
