# 評分報告可解釋性升級（Evaluator Report Explainability）

- 日期：2026-07-07
- 狀態：設計已核准，待寫實作計畫
- 範圍：一份 spec、一個 PR，涵蓋 A/B/C/D 四塊

## 背景與問題

Admin 在 `/dashboard/organizations/[id]/members` 只看得到成員的**總分**；點進成員報告（`ReportDetail`）也只看到總分、trend、LLM 敘事（目前恆為 null）、以及少數帶引文的命中 signal。**看不到「評分過程」——為什麼是這個分數、哪些規則達標、哪些沒達標、資料從哪來。**

調查（三個 explore agent）確認：**評分依據的原料幾乎都已算出並存進 DB，只是前端沒渲染**；LLM 敘事分支已完整實作但從未開通，且開通路徑有一個斷點。因此本案主體是「補前端呈現」＋「補 LLM 敘事開通 wiring」，**不動評分引擎核心邏輯、不改既有評分結果**。

## 目標

1. 成員報告能看到每個 section 的**所有 signal**（含未命中）、實際值、門檻，以及 standard/superior 判定依據。
2. 能看到報告的**資料來源與涵蓋率**（gateway vs telemetry、body coverage）。
3. Admin 看成員時能看到與「使用者看自己」一致的**行為下鑽**（facet summary）。
4. 開通 **LLM 白話文敘事**，並在報告呈現逐條 evidence（引文＋rationale）。
5. Admin 成員報告與使用者自己的 profile 報告**呈現一致**（共用元件）。

## 非目標（YAGNI）

- 不做 continuous scoring（維持現有 binary standard/superior per section）。
- 不落地 LLM 回傳的 `sectionAdjustments`（目前 parse 後丟棄，維持）。
- 不改 rubric 編輯流程。
- 不改任何既有評分數值或評分引擎演算法。

## 現況（調查結論）

### 資料已在 DB（`evaluation_reports`）

`reports.getUser` 以 `db.select()` 回**全欄位**（非 subject 且非 org_admin 時 redact 6 個 LLM 欄位）。既有但**前端未渲染**的欄位：

- `section_scores` (jsonb, `SectionResult[]`) — 已部分渲染，但只顯示「命中且有 evidence」的 signal。
- `signals_summary` (jsonb, `Metrics`) — 未渲染。
- `data_quality` (jsonb) — `ReportDetail` 未渲染（僅 `DryRunPreview` 用）。
- `source_breakdown` (jsonb, `{ gateway_events, transcript_events, overlap }`) — 未渲染（schema 註解明言「reviewer 可看資料來自哪條路徑」）。
- `llm_narrative` (text) / `llm_evidence` (jsonb) — narrative 已渲染（但恆 null），evidence 未渲染。

### 關鍵資料結構

```ts
// packages/evaluator/src/engine/types.ts
interface SignalHit    { id; type; hit: boolean; value?: number; evidence?: Evidence[] }
interface SectionResult{ sectionId; name; weight; standardScore; superiorScore; score; label; signals: SignalHit[] }
// packages/evaluator/src/llm/responseParser.ts
interface LlmEvidence  { quote: string; requestId: string; rationale: string }
// apps/api/src/services/facetSummary.ts
interface FacetSummary { total; succeeded; failed; avgClaudeHelpfulness; totalFrictionCount;
                         totalBugsCaught; totalCodexErrors; sessionTypeCounts; outcomeSuccessRate }
```

`SectionResult` 已含每條 signal 的 `hit` / `value` / `evidence`。**未單獨儲存**的中間量：keyword 的 `minRatio` 命中比率、`superiorRules` 的 strong/support 達標計數——但可由已存的 `signals[]` ＋ rubric 定義（門檻）反推。rule-based 路徑**沒有** per-rule 文字 rationale（那只存在於 LLM 分支）。

### rubric 定義前端可取

`rubrics.get(rubricId)` 回傳整列含 `definition` (jsonb, 完整 rubric)。RBAC：platform default（`orgId=null`）任何有 `rubric.read` 的 authed user 可讀；org-custom 需該 org `rubric.read`。`definition` 內每個 signal 帶門檻（`threshold.gte/lte/between`、`keyword/client_mix.minRatio`、`refusal_rate.lte`、diversity 類 `gte`、facet 類…），section 帶 `standard/superior.{score,label,criteria[]}` 與 `superiorRules`。

### LLM 敘事分支（已實作，未開通）

- 觸發 gate（`runEvaluation.ts`）：`org.llm_eval_enabled === true` **且** `dataQuality.coverageRatio >= 0.5`，再過月預算 halt gate，再過 `runLlm` 內三層確認（Redis 有 eval key、org flag、`llm_eval_model` 非空）。
- 呼叫方式：`runLlm` 取 Redis `caliber:gw:llm-eval-key:<orgId>` 的 eval key，**loopback 打 gateway 自己的 `/v1/messages`**（`max_tokens: 4000`），upstream 帳號由 scheduler 挑。
- 失敗 fail-soft：任一步失敗 `return null`，narrative 留空，**報告照常產出**。
- 設定 UI 已完整：`/dashboard/organizations/[id]/evaluator/settings`（`SettingsForm`）→ `contentCapture.setSettings` 可寫 `llmEvalEnabled` / `llmEvalAccountId` / `llmEvalModel` / `llmMonthlyBudgetUsd` / `llmBudgetOverageBehavior`。

### 兩個 gap（本案處理）

1. **provision 斷點**：`provisionLlmEvalKey()` 全 repo 只有測試呼叫過；`setSettings` 開 flag 時**不會**建 eval key / 寫 Redis → 開了 flag 也走 `missing_key` → narrative 恆 null。**必補。**
2. **account-pin gap**：`runLlm` 不讀 `llm_eval_account_id`（UI 有該 select 但無效）→ eval 帳號實際由 scheduler 決定。**本案 wire 它。**

## 設計

### 共用原則

- 新可解釋性區塊抽成**共用元件**（`apps/web/src/components/evaluator/`），同時掛在 `ReportDetail`（admin 看成員）與 `ProfileEvaluation`（使用者看自己），消除「admin 看得比使用者少」的不一致。
- A/B/C 不改 DB schema、不改引擎；D 僅補 wiring 與前端呈現。

### A. 規則明細（SignalBreakdown）

- 擴充 section 展開內容：不再只顯示「命中且有 evidence」的 signal，改列出**該 section 的所有 signal**。
- 每條 signal 呈現：名稱 / 命中狀態（✓ / ✗）/ 實際值 `value` / type / **門檻**（來自 rubric definition）。
- 命中的 signal 仍展開其 `evidence` 引文。
- section 標頭呈現 standard vs superior 判定，並以 `superiorRules`（strong/support 門檻）＋各 signal hit 說明「為何判定為此等級」。
- **門檻資料來源**：以報告當下記錄的 `report.rubricId` 呼叫 `rubrics.get(rubricId)`（**非** org 目前 active rubric），把 signal id 對應到 rubric definition 內的門檻欄位。前端合併「report 的 signal hit/value」與「rubric 的門檻定義」後渲染。
- 若 rubric 取不到（NOT_FOUND / 權限）：優雅降級，只顯示 hit/value，不顯示門檻。

### B. 資料來源與涵蓋率（DataProvenanceCard）

- 新卡片（純展示），讀 `source_breakdown`（gateway_events / transcript_events / overlap）、`data_quality`（coverageRatio、captured / missing / truncated requests）、`signals_summary` 的期間（requestCount / bodyCount）。
- 無隱私顧慮，對所有能看到報告的角色顯示。
- `source_breakdown` 可能為 null（per-key 報告不寫）：null 時該分項略去或標「不適用」。

### C. 行為下鑽（掛 FacetSummaryCard）

- `ReportDetail` 新增呼叫既有 `reports.facetSummary`（gate `report.read_user`，output `FacetSummary`，空窗回 `EMPTY_SUMMARY` 不 throw）並掛既有 `FacetSummaryCard`。
- 使 admin 成員報告與使用者 profile 一致。

### D. LLM 敘事開通 + evidence 呈現

**後端 wiring：**

1. **provision on enable**（必補）：`contentCapture.setSettings` 偵測 `llmEvalEnabled` false→true 轉換時，呼叫 `provisionLlmEvalKey(orgId)`（建 eval key + 寫 Redis），仿照現有 `contentCaptureEnabled` first-enable 偵測。need idempotent（重複開關不重複建；service 已對 key name 有處理，plan 階段確認）。
2. **account-pin**（本 PR 較高風險）：`runLlm` 讀 `org.llm_eval_account_id`；非 null 時讓 loopback `/v1/messages` 請求帶一個**內部 header**（例如 `x-caliber-eval-account-id: <id>`），gateway scheduler 見到此 header 時**直選該 account**、bypass sticky / load-balance；null 時維持現行 scheduler 行為。具體綁定機制（header 名稱、scheduler pin 路徑、與現有 routing_policy 的交互、找不到該 account 時 fallback）**留待 plan 階段細化**，並加 gateway 整合測試。
3. 營運（operator 於 UI 設定，非程式）：為 OneAD 開 `llmEvalEnabled`、指定專屬訂閱 OAuth 帳號為 `llmEvalAccountId`、`llmEvalModel` 填建議預設、預算 `degrade`。

**前端呈現：**

4. `narrative` 已由 `ReportDetail` 的 AI narrative card 渲染（僅在非空時）。
5. 新增 `llm_evidence` 呈現元件：逐條顯示 `quote`（引文）＋ `rationale`（為何支持此評分）＋ `requestId`。權限由既有 `redactLlm` 把關（subject 本人 + org_admin，`canSeeLlm = userId === caller || report.read_org`；team_manager 被 redact）。

**建議預設**：`llm_eval_model = claude-haiku-4-5`（量大場景省成本；operator 可於 UI 自改）。成本備註：eval 走訂閱 OAuth 帳號時 `usage_logs.total_cost = 0`（flat-rate），月預算 gate 實務上不觸發；真正計費只在走 pool API key 時發生。

## 決策紀錄

| 決策 | 選擇 | 理由 |
|---|---|---|
| 呈現內容 | A+B+C+D 全部 | 使用者要完整可解釋性 |
| 分期 | 一次全上（單一 spec/PR） | 使用者選定 |
| 白話文來源 | 開啟既有 LLM 敘事分支 | 使用者選定；分支已實作，主要是開通 |
| eval 帳號 | wire `llm_eval_account_id`，可指定專屬帳號 | 避免 eval 流量污染他人 own rate limit；讓 UI 既有 select 生效 |
| eval model 預設 | `claude-haiku-4-5` | 敘事量大、成本敏感 |
| A 門檻來源 | `rubrics.get(report.rubricId)` | 反映評分「當下」門檻，非 org 現行 |
| 呈現位置 | 共用元件掛 admin + 自己 profile | 消除視角不一致 |

## 測試策略

- **單元**：A 的「signal hit/value + rubric 門檻」合併呈現邏輯；B 的欄位映射（含 null source_breakdown 降級）；D 的 evidence 呈現與 redact gating。
- **整合**：`setSettings` 開 flag → 觸發 `provisionLlmEvalKey`（Redis key 出現）；gateway account-pin（帶 header → 選中指定 account；找不到 → 定義的 fallback）。
- **權限**：非 subject / 非 org_admin 呼叫 `getUser` 時 llm_narrative/llm_evidence 被清空的既有行為不回歸。
- 沿用既有 web 元件測試與 api 整合測試框架；不新增 e2e。

## 風險

1. **account-pin（最高）**：動到 gateway scheduler 選帳號路徑，可能與 routing_policy / sticky 交互出錯。緩解：header-gated、僅 eval loopback 走此路徑、整合測試覆蓋 pin 命中/未命中/fallback；若 plan 階段評估過重，可退回「不 wire、交給 scheduler」並把 UI select 標為暫未生效。
2. **provision idempotency**：重複開關 flag 不應重複建 key 或洩漏舊 key。plan 階段確認 service 語意。
3. **rubric 版本漂移**：報告的 `rubricId` 指向的 rubric 若已軟刪除，`rubrics.get` 可能 NOT_FOUND → A 降級為不顯示門檻（已納入設計）。

## 開通 / 營運步驟（operator，部署後）

1. 確認 `ENABLE_EVALUATOR=true`。
2. `/dashboard/organizations/onead/evaluator/settings` 開 `llmEvalEnabled`、選專屬 eval 帳號、`llmEvalModel=claude-haiku-4-5`、預算 degrade。
3. 開 flag 後由新 wiring 自動 provision eval key（驗證 Redis `caliber:gw:llm-eval-key:<orgId>` 有值）。
4. 對成員 `reports.rerun` 或等次日 cron；驗證報告出現 narrative + evidence。

## 受影響檔案（初判，plan 階段細化）

- 前端：`apps/web/src/components/evaluator/ReportDetail.tsx`、`EvidenceRow.tsx`、`ProfileEvaluation.tsx`、`FacetSummaryCard.tsx`（掛用）、新元件 `SignalBreakdown*.tsx` / `DataProvenanceCard.tsx` / `LlmEvidenceList.tsx`；i18n 5 catalog。
- API：`apps/api/src/trpc/routers/contentCapture.ts`（provision wiring）；（A 直接用既有 `rubrics.get`，無需新 procedure）。
- Gateway：`apps/gateway/src/workers/evaluator/runLlm.ts`（讀 account id、帶 header）、`apps/gateway/src/runtime/scheduler.ts`（account-pin 路徑）。
- 無 DB migration。
