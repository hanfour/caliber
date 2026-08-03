# 單筆請求重放（Replay）— design

**Date:** 2026-08-03
**Status:** Approved (pending spec review)

## Problem

Caliber 的 gateway 已經逐筆封存了每一次請求的完整內容——`request_bodies`
存著加密的 request body / response body / thinking body 與 `request_params`，
`usage_logs` 存著 `requested_model` / `upstream_model`、tokens、成本、延遲、
`stop_reason` 與 retry 軌跡。也就是說，「某年某月某日、某個模型、對某個 prompt、
實際吐出什麼」這件事已經是庫裡的既有資產。

但這份資產目前**只被評分管線讀取，沒有任何人能拿它回答除錯問題**。當某一筆請求
的結果不對時，operator 無法回答最基本的一問：「這是模型的錯，還是我們的 prompt
的錯？」

本設計把既有封存變成可操作的除錯工具：挑出歷史上任一筆請求，換一個模型重跑，
左右對照。

### 這不是什麼

**我們無法倒帶模型本身。** 權重在 Anthropic 手上，`claude-opus-5` 今天的行為與
三個月前不保證一致，舊版下架後也叫不回來。本功能備份與還原的是**模型說過什麼**，
不是**模型是什麼**。時光機的深度上限 = `request_bodies.retention_until`
（由 `apps/gateway/src/workers/bodyCapturePersist.ts` 的 `retentionDays` 決定），
過期即永久消失。

## Decisions (approved 2026-08-03)

1. **只做單筆、隨選重放。** 不做 golden set、不做排程、不做漂移監測。
2. **唯一變因是模型。** Body 一字不改，只能選 target model。不開放編輯
   prompt/tools/參數——一旦能改就失去「同一基準」的意義，也引入「改過的 prompt
   算誰的」這種稽核問題。
3. **重放走真實 gateway 路徑並照常記帳**，但以 `replay_of_request_id` 標記，
   評分側一律排除、成本側獨立顯示。不製造成本黑洞。
4. **執行端在 gateway，不在 API。**
5. **UI 走輕量版**：請求清單（不解密）+ 對照頁（才解密）。不做完整的請求瀏覽器。

## 為什麼執行端必須在 gateway

API server **不保證持有** `CREDENTIAL_ENCRYPTION_KEY`。這是既有的明文約束，
寫在 `apps/api/src/trpc/routers/reports.ts:733`：

> Bodies are listed by requestId only — no decrypted content, since the api
> server does not hold `CREDENTIAL_ENCRYPTION_KEY` in all environments.

因此解密 `request_bodies` 只能在 gateway 端進行。API 負責發起與查詢結果，
gateway worker 負責解密與執行。這與現有 evaluator worker 同形，不引入新的部署面。

## 憑證與 attribution

**重放一律使用 org 層級的 eval key**，即 evaluator loopback 用的同一把
（`apps/gateway/src/workers/evaluator/runLlm.ts:71`，Redis key 為
`LLM_KEY_REDIS_PREFIX + orgId`）。

原因：api key 在 DB 中是雜湊儲存，raw key 只在發放當下存在，**worker 沒有任何
途徑取得某個成員本人的 key**。若要讓 `usage_logs` 掛在「按下重放的人」名下，
就得發明一個「覆寫 usage_log attribution」的機制——對一個拿來打考績的系統而言，
那等於做出一把可以偽造歸屬的槍。明確拒絕。

採用 org eval key 的結果反而更乾淨：

- 所有重放流量聚在一把**非真人金鑰**下，不落在任何成員身上
- 「誰按的」記在 `replay_runs.triggered_by`，稽核仍然完整
- 排除過濾天然安全

**已知耦合：** 重放因此綁在 `organizations.llm_eval_enabled` 與 Redis 中存在
eval key 這兩個前提上。任一不成立時，`replay.enqueue` 必須以明確錯誤拒絕
（`eval_key_unavailable`），不得靜默失敗。

## Component 1 — Schema（migration 0034）

新表 `replay_runs`（`packages/db/src/schema/replayRuns.ts`）：

| 欄位 | 說明 |
|---|---|
| `id` uuid PK | |
| `org_id` uuid FK cascade | |
| `source_request_id` text FK → `usage_logs.request_id` | 被重放的原始請求 |
| `replay_request_id` text nullable | 重放產生的那筆 `usage_logs`；失敗時為 null |
| `target_model` text | |
| `triggered_by` uuid FK → users | **誰按的**（真正的 attribution） |
| `status` text | `queued` \| `running` \| `ok` \| `failed` |
| `failure_reason` text nullable | |
| `fidelity` jsonb | 保真度旗標，見 Component 3 |
| `created_at` / `completed_at` | |

索引：`(org_id, created_at)` 供清單查詢，`(source_request_id)` 供「這筆重放過幾次」。

`usage_logs` 新增一欄：

```sql
ALTER TABLE usage_logs ADD COLUMN replay_of_request_id text;
CREATE INDEX usage_logs_replay_idx ON usage_logs (replay_of_request_id)
  WHERE replay_of_request_id IS NOT NULL;
```

用可空字串而非 boolean——同時回答「這是重放」與「重放的是哪一筆」，一欄兩用。
partial index 讓非重放列（絕大多數）不佔索引空間。

`0034_down.sql` 需對應提供 drop（沿用本專案既有的 down-migration 慣例）。

## Component 2 — 污染防治：view，不是 14 個 WHERE

`usage_logs` 目前有 **14 個查詢點散在 9 個檔案**。逐一檢視用途後，只有**依
user/org/期間做聚合**的查詢會被重放污染——那種查詢會把重放誤算成某人的工作。
依 `requestId` 精準查單列的查詢不但不受影響，**改讀 view 反而會壞掉**。

**必須改讀 view（4 處，聚合型）**

```
apps/api/src/trpc/routers/rubrics.ts:484              rubric 校準取某成員某期間全部 usage
apps/api/src/services/facetSummary.ts:72              facet 聚合，join usage_logs 篩 user + 期間
apps/gateway/src/workers/evaluator/runRuleBased.ts:119 評分主查詢
apps/gateway/src/workers/evaluator/cron.ts:178        評分候選選取
```

**必須維持讀原表（4 處）**

```
apps/gateway/src/workers/evaluator/runLlm.ts:182               WHERE requestId = <該次 LLM 呼叫> 回填成本
apps/gateway/src/workers/evaluator/ledgerDeepAnalysis.ts:242   同上，ledger 回填
apps/gateway/src/workers/githubDelivery/runDeliveryQuality.ts:393  同上（pollUsageLogCost）
apps/api/src/trpc/routers/reports.ts:767                       GDPR exportOwn，資料可攜需完整
```

前三者是單列成本回填：查的是「剛才那次呼叫花了多少錢」。若改讀 view，一旦該次
呼叫本身帶有 `replay_of_request_id`（未來重放若要回填成本即是此情形），成本將
**永遠查不回來**——view 看不到它。此處無污染風險（本就只查一列），換了純屬有害。

在所有查詢點各補一個 `AND replay_of_request_id IS NULL` 則是「今天做對、半年後被
新程式碼默默破壞」的解法，而破壞的形式是**某人的考績多了幾分**，不會有人察覺。

改為預設安全：

```sql
CREATE VIEW usage_logs_scored AS
  SELECT * FROM usage_logs WHERE replay_of_request_id IS NULL;
```

本專案已有 view 前例（`packages/db/drizzle/0014_evaluator_events_view.sql`），
不是新發明。消費端切成三層：

- **聚合型評分查詢（上列 4 處）** → 改讀 `usage_logs_scored`。日後新寫的評分
  程式碼沿用慣例即自動安全。
- **單列成本回填與 GDPR 匯出（上列 4 處）** → 維持原表，不動。
- **成本側（`usage.ts` 6 處）** → 繼續讀原表，但**把重放的成本獨立成一行顯示**。
  「寫入但標記排除」的初衷就是不要有黑洞，那就要真的看得見。

判準一句話：**查的是「這個人這段期間做了什麼」就用 view；查的是「這一筆花了
多少錢」就用原表。**

## Component 3 — 保真度閘門

重放**不是**乾淨對照。以下四件事會讓「重放 ≠ 原始條件」，UI 必須主動揭露，
否則此功能會產出看起來嚴謹、實際錯誤的結論。

| 情況 | 後果 | 處理 |
|---|---|---|
| `body_truncated = true` | 重放的根本不是原始輸入 | **拒絕重放**，`failure_reason = truncated_not_replayable` |
| `tool_result_truncated = true` | 工具結果被砍過，模型看到的上下文不同 | 允許，強制標示警告 |
| 原請求有大量 `cache_read_tokens` | 重放是冷快取 → 成本與 `first_token_ms` 完全不可比 | 對照表把延遲與成本標為「不可比」 |
| 上游帳號已輪替／刪除 | 重放走的是**現在**的路由 | 記入 `fidelity` jsonb |

`fidelity` jsonb 的形狀：

```json
{
  "toolResultTruncated": false,
  "originalCacheReadTokens": 48213,
  "originalAccountId": "…",
  "originalAccountStillExists": true,
  "streamingDisabled": true
}
```

重放**強制關閉 streaming**（要完整 body 才好比對），這本身也讓延遲數字不可比，
故一律記錄 `streamingDisabled: true`。

### Noise baseline（必要，不是選配）

同模型、同 body 重跑，輸出本來就不同。因此對照頁**必須**提供「用同一個模型再跑
一次」的按鈕。沒有這條 noise baseline，使用者無從判斷差異來自模型換代還是取樣
隨機性——這是本功能能否用於下判斷的關鍵，不是加分項。

## Component 4 — 執行流程

```
web 請求清單 ──▶ tRPC replay.enqueue ──▶ BullMQ ──▶ gateway worker replayRun
  (只讀 usage_logs,          (權限 + 入列)                │ 解密 request_body
   不解密)                                                │ 覆寫 model
                                                          │ POST 自身 /v1/messages
  web 對照頁 ◀── tRPC replay.get ◀── replay_runs ◀────────┘
```

**tRPC router `replay`**（`apps/api/src/trpc/routers/replay.ts`）：

- `enqueue({ requestId, targetModel })` → 權限檢查、保真度預檢（truncated 直接
  拒絕，不浪費一趟 worker）、寫 `replay_runs(status='queued')`、入列
- `get({ runId })` → 狀態 + 結果（結果內容由 worker 寫回，API 不解密）
- `listForRequest({ requestId })` → 該筆的歷次重放

BullMQ jobId 直接用 `runId`（uuid），**不得含冒號**——v0.17.1 曾因 colon jobId
造成 evaluator 入列失效。

**gateway worker `replayRun.ts`**（`apps/gateway/src/workers/`）：

1. 讀 `request_bodies`，以 `safeDecrypt(masterKeyHex, requestId, sealed)` 取出
   request body（既有 helper，見 `runRuleBased.ts`）
2. 重驗保真度閘門（API 端的預檢是 UX，此處才是權威）
3. **僅覆寫 `model` 一欄**為 `targetModel`，並強制 `stream: false`。其餘欄位
   原封不動
4. POST 至自身 `/v1/messages`（`runLlm.ts:113` 的既有 loopback 形狀），
   `Authorization: Bearer <org eval key>`；若 org 有設定
   `llm_eval_account_id`，帶上 `x-caliber-eval-account-id`
   （`apps/gateway/src/runtime/evalAccountPin.ts`）
5. 從回應的 `x-caliber-resolved-model`（`apps/gateway/src/models/aliasWiring.ts:66`）
   取得實際解析到的上游模型，寫入 `replay_runs`——alias 可能解析到與預期不同的
   版本，這一欄是唯一能事後查證的憑據
6. 從回應的 `x-request-id`（`apps/gateway/src/server.ts:182`）取得重放那筆的
   request id，回寫 `replay_runs.replay_request_id`。**此 header 缺失時必須寫
   `status='failed'` 並記錄，不得靜默丟棄**——v0.27.3 修的正是這個坑：evaluator
   當時在 `if (!requestId)` 直接 bail，導致每一份 LLM 報告都被無聲丟棄
7. 回寫 `replay_runs`：`status`、`completed_at`、`fidelity`

重放產生的請求會由既有的 body capture 管線照常封存，因此**重放的結果本身也可以
再被重放**，無需特例處理。

### `replay_of_request_id` 如何寫入（防偽關鍵）

重放的 `usage_logs` 列是由 gateway 的**正常請求路徑**（`writeUsageLogBatch.ts`）
寫入的，worker 並不直接寫它。標記透過一個新的內部 header 傳遞：

```
x-caliber-replay-of: <sourceRequestId>
```

**這個 header 必須防偽，否則任何持有 api key 的成員都能自行標記流量為重放，
讓自己的請求從評分中消失。** 這是本設計最嚴重的潛在漏洞。

解法沿用既有模式，不需發明：`apps/gateway/src/runtime/evalAccountPin.ts` 對
`x-caliber-eval-account-id` 的處理已經解過同一題——該 header **只在請求以 eval
key（`keyPrefix === "caliber-eval"`）認證時才被信任**，而 eval key 的 raw 值只
存在於 gateway 內部 Redis，外部 client 無從取得，故前綴即為充分的防偽閘門。

重放走的正是同一把 org eval key，因此新增 `replayOfHeader(req)` helper，
與 `evalAccountPin` 同檔同形：非 `caliber-eval` 前綴一律回傳 `undefined`，
header 直接丟棄。

### 失敗處理

worker 任一步失敗一律寫 `status='failed'` + 具體 `failure_reason`
（`truncated_not_replayable` / `body_missing` / `decrypt_failed` /
`eval_key_unavailable` / `upstream_error` / `retention_expired`），
**不得靜默略過**。UI 直接顯示原因。

## Component 5 — UI（輕量版）

**請求清單** — 成員頁新增「請求」分頁。表格欄位全部來自 `usage_logs`，
**不需解密**：時間、`requested_model`、`upstream_model`、tokens、成本、
`status_code`、`duration_ms`、`stop_reason`。每列一顆「重放」。

已截斷（`body_truncated`）的列，重放鈕 disabled 並附說明——在使用者花錢之前就
講清楚，而不是失敗後才說。

**對照頁** — 左右並排原始與重放：

- 上方：模型、`upstream_model`（實際解析結果）、tokens、成本、延遲
- 中間：response body 並排；差異以 diff 標示
- 保真度警告橫幅（cache 冷熱、streaming、truncated tool result）置於對照內容
  **上方**，不是頁尾註腳
- 「用同一模型再跑一次」按鈕（noise baseline）
- 延遲與成本欄位在 cache 不可比時，明確標記為不可比而非直接顯示數字

解密內容**只在此頁出現**，清單頁零解密面。

## Component 6 — 權限與稽核

重放不只是「讀」：它會**解密他人的 prompt 全文**並且**花真的錢**。因此不搭在
現有讀取權之上：

- 新增獨立權限 `request.replay`，預設授予 org admin 與請求本人。判定基礎沿用
  `apps/api/src/trpc/routers/sessions.ts` 的 `ensureCanReadUser`，但為獨立開關
- 每次重放寫一筆 audit log（`packages/db/src/schema/audit.ts` 既有）：
  誰、重放了誰的哪一筆、換成什麼模型、花了多少
- **速率限制**：每人每小時 N 次（預設 20），避免狂按燒錢。超限回
  `TOO_MANY_REQUESTS`

## Testing

**Unit**

- 保真度閘門：`body_truncated` 必須被拒
- model 覆寫：斷言**只有 `model` 與 `stream` 兩欄改變**，其餘 body 逐欄相同
- `failure_reason` 分類正確
- 速率限制計數
- **`x-caliber-replay-of` 防偽**：以一般成員 api key 帶上該 header 時必須被
  丟棄，產生的 `usage_log` 其 `replay_of_request_id` 為 null（即照常計入評分）

**Integration**

- `enqueue` → worker → `replay_runs` 落地，`status='ok'`
- 重放產生的 `usage_logs` 帶有正確的 `replay_of_request_id`
- `usage_logs_scored` view 確實濾掉重放列
- 權限：非 admin 非本人 → `FORBIDDEN`

**回歸（本功能真正的防線）**

> 在現有評分測試的 fixture 中塞入一筆 replay `usage_log`，斷言**分數完全不變**。

這條測試在，未來任何人讓重放流量漏進評分，CI 會擋下。沒有它，Component 2 的
view 只是君子協定。同一條斷言需覆蓋 evaluator 評分與 GitHub delivery 評分兩側。

**E2E（Playwright）**

清單 → 點重放 → 對照頁顯示雙欄結果與保真度橫幅。

## Out of scope

明確不做，避免範圍潛移：

- Golden set / 回歸套件 / 排程重放
- 模型漂移的持續監測與告警
- 編輯 prompt 後重放（prompt playground）
- 批次重放
- 跨 org 比較

前三項都建立在本功能之上，日後若要做，本設計的 `replay_runs` 與
`usage_logs_scored` 是可直接沿用的地基。

## Open risks

1. **成本可見性依賴 UI 落實。** view 讓評分側安全，但成本側「獨立一行」若沒做，
   重放的錢會混進成員成本。這是本設計唯一沒有 CI 防護的環節，需在 code review
   明確確認。
2. **`llm_eval_enabled` 耦合。** 尚未啟用 LLM eval 的 org 無法使用重放。若日後
   需解耦，應引入獨立的 replay 專用金鑰設定，而非放寬 attribution 規則。
3. **retention 決定可回溯深度。** 目前的 `retentionDays` 設定值即為時光機上限，
   使用者需理解「查不到」與「沒發生」的差別——清單頁應對超出 retention 的期間
   顯示明確說明，而非空白。
