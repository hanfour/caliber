# Rubric v2 — 連續計分設計（對齊 ITO 季評分 KPI）

Status: **APPROVED — 2026-07-13 operator 定案**（量表保留 0–120；satisfaction facet 納入首發；keyword 衛生修復一起做；Phase 1–3 一次實作）→ **實作完成 — 2026-07-13，branch `feat/rubric-v2-continuous-scoring`**（13 tasks，見 §10 Implementation notes）；`is_default` 翻轉待校準 dry-run 通過後另出 migration（§8 step 4，範圍外）
Date: 2026-07-13
Scope: `@caliber/evaluator` engine、platform-default rubric、evaluation_reports、web evaluator UI

---

## 1. 背景：為什麼人人 120 分

現行 platform rubric（v1.3.0）在結構上幾乎保證滿分：

| 病灶 | 位置 | 效果 |
|---|---|---|
| 每 section 只有 100/120 兩檔，**零命中也拿 100** | `sectionScorer.ts` | 總分只有 {100, 108, 112, 120} 四種值 |
| keyword 掃**整包 request body**（含 system prompt、全部歷史、tool results） | `ruleEngine.ts` `bodyToString` | 對話歷史滾雪球 → 一句「refactor」讓之後每個 body 都命中，minRatio 0.4/0.5 失效 |
| `noiseFilters` 只存在 schema，引擎從未套用 | `rubric/schema.ts:149` | `<system-reminder>` 等噪音直接參與 keyword 命中 |
| riskControl superior 只要一組 keyword、`minSupportHits: 0` | seed 0003 | 60% 權重的 section 躺著過 |
| LLM 深度分析不調分 | `runEvaluation.ts`（`totalScore: rb.report.totalScore`） | 名義上的 "LLM adjustments" 不存在 |

對照組：ITO 季評分（`/ito-quarterly-scoring`，2026 Q2 定案）用連續量表 + LLM 讀報告抽證據 + 橫向校準，實際分布 80–92，有鑑別度。

## 2. 目標與非目標

**目標**

1. 月度自動評分有真實分布（不再全員同分），可直接作為季評分 KPI 三子項的佐證資料。
2. 計分主要來源改為 **facet signals**（LLM 逐 session 判讀的語意訊號），keyword 從 platform default 退場。
3. 分數 deterministic、可稽核：同一份資料重跑得到同一個分數，每一分都能回溯到 signal 值。

**非目標**

- 不動季評分流程本身（季評分仍是正式績效，Caliber 是月度佐證訊號）。
- 不移除 `keyword` signal type（既有 org/key 自訂 rubric 相容性）。
- 不做跨成員相對計分（percentile 只做顯示，分數本身維持絕對量尺，校準靠曲線參數定期調整）。
- LLM 不直接調總分（LLM 的判斷已封裝在 facets；保持規則層 deterministic）。

## 3. 量表：保留 0–120，及格線 108（DECIDED）

Operator 定案保留 0–120（不動既有 UI 刻度與歷史趨勢的量尺）。與季評分的對映：季評分 90/100 及格 ⇔ Caliber 108/120（同為 90%）。

- rubric 新增頂層欄位 `scale: { max: number, pass?: number }`（optional；缺省 `{ max: 120 }`）。platform v2 設 `{ max: 120, pass: 108 }`。
- continuous section 分數 = `scale.max × Σ(points_i × subscore_i) / Σ(points_i)`，總分為 weight 加權平均。
- **不需要** `evaluation_reports.score_scale` 欄位（全量尺一致）；UI 只需補畫及格線與「資料不足」狀態。

## 4. Schema 擴充：continuous section（向後相容）

`sectionSchema` 新增 optional 欄位；**缺省時走既有 tiered 路徑，現存自訂 rubric 的 zod parse 結果 byte-identical**。

```jsonc
{
  "id": "efficiency",
  "name": "效率·AI交互",
  "weight": "25%",
  "scoring": { "mode": "continuous" },   // 新；缺省 = "tiered"
  "signals": [
    {
      "type": "facet_claude_helpfulness",
      "id": "helpfulness",
      "gte": 3.5,                          // tiered 相容欄位，continuous 模式忽略
      "points": 50,                        // 新：此 signal 在 section 內的配分
      "curve": { "zeroAt": 2.5, "fullAt": 4.5 }  // 新：value→分數的線性映射
    }
  ]
  // continuous section 不需要 standard/superior/superiorRules
  // （schema 上改為 optional，tiered section 仍必填 → refine 驗證）
}
```

**曲線語意**：signal 的 `value`（`SignalHit.value`，所有 signal type 都已回傳）經 clamp 後線性映射：

- `zeroAt < fullAt` → 越高越好：`value ≤ zeroAt` 得 0、`≥ fullAt` 得滿配分、中間線性。
- `zeroAt > fullAt` → 反向（越低越好，如 friction/errors/refusal），同樣線性內插。

**section 分數** = `100 × Σ(points_i × subscore_i) / Σ(points_i)`（subscore ∈ [0,1]）。
**總分** = section 分數按 weight 加權平均，clamp 到 `[0, scale.max]`。

### 4.1 無資料語意（關鍵修正）

現行反向 facet（friction/codex_errors）在無資料時回 `hit: true`——tiered 模式合理，continuous 模式會變成「沒資料 = 滿分」，必須擋掉：

- `SignalHit` 新增 `sampleCount?: number`（facet collectors 回傳 `present.length`；非 facet signal 回傳 usage/body 列數）。
- continuous scorer 對 `sampleCount === 0` 的 signal 視為 **null**：不給分也不扣分，把它的 points 從分母移除（等比重分配給有資料的 signals）。
- section 層新增 optional `minSamples`（預設 5）：有效樣本低於門檻 → section score = null。
- 任一 section 為 null → 報告 `totalScore = null`、新欄位 `insufficient_data = true`，UI 顯示「資料不足」而不是假分數。facet 未啟用的 org 會落在這裡，提示開啟 `llm_facet_enabled`（或自訂 pin 舊 v1 rubric）。

## 5. Platform rubric v2.0.0 — 三 section 鏡射季評分 KPI

權重比照季評分 KPI 子項（效率 10 / 品質 20 / 滿意 10 → 25% / 50% / 25%）。曲線參數是**初始值**，定案前先用 dry-run 對 11 位成員的真實資料校準（同 #261 的做法）。

### 效率·AI交互（25%）

| signal | points | curve | 語意 |
|---|---|---|---|
| `facet_claude_helpfulness`（session 平均 1–5） | 50 | zeroAt 2.5 → fullAt 4.5 | AI 有沒有真的幫上忙 |
| `facet_friction_per_session`（平均，反向） | 30 | zeroAt 3.0 → fullAt 0.5 | 交互摩擦（重試、誤解、繞路） |
| `cache_read_ratio`（threshold metric） | 20 | zeroAt 0.1 → fullAt 0.6 | context 重用效率（長對話經營） |

### 品質·AI風控（50%）

| signal | points | curve | 語意 |
|---|---|---|---|
| `facet_bugs_caught`（**每 session 率**，見 §5.1） | 45 | zeroAt 0 → fullAt 0.5/session | 主動抓出 AI 錯誤/幻覺 |
| `facet_codex_errors`（每 session 率，反向） | 30 | zeroAt 1.0 → fullAt 0.1/session | 放行的 AI 產出錯誤 |
| `refusal_rate`（反向） | 25 | zeroAt 0.3 → fullAt 0.05 | 提示品質/合規互動 |

### 需求方滿意（25%）

| signal | points | curve | 語意 |
|---|---|---|---|
| `facet_outcome_success_rate` | 70 | zeroAt 0.4 → fullAt 0.85 | session 目標達成率（success+partial） |
| `facet_user_satisfaction`（session 平均 1–5，**新 facet**） | 30 | zeroAt 2.5 → fullAt 4.5 | 從對話收尾語氣/採納行為判讀的使用者滿意度 |

> **DECIDED：`userSatisfaction` facet 納入首發**——facet extractor prompt 增加第 7 個欄位、`facet 表`新增 `user_satisfaction` int 欄位（nullable）、新 signal type `facet_user_satisfaction`（mean-gte 語意，同 helpfulness）。舊 facet 列該欄為 NULL，自然被排除在平均之外（§4.1 sampleCount 語意涵蓋）。**keyword signal 不出現在 v2 任何 section。**

### 5.1 facet 率值正規化

`facet_bugs_caught` / `facet_codex_errors` 現為視窗總和，跟用量成正比（重度使用者天然占優）。新增 optional `normalize: "per_session"`：value = sum ÷ 有 facet 資料的 session 數。tiered 模式缺省不變。

## 6. keyword 衛生修復（獨立 PR，供仍用 keyword 的自訂 rubric）

1. **真正套用 `noiseFilters`**：keyword 掃描前先把 rubric 的 noiseFilters 片段從文本剔除。
2. **只掃最新一輪真人輸入**：從 request body 取「最後一個 user message 中非 `tool_result` 的 text blocks」，不掃 system prompt、歷史 messages、工具輸出——消除歷史滾雪球，讓 minRatio 恢復「多少比例的『轉』出現此語言」的原始語意。

## 7. Web/UI 變更

- 量尺維持 120，`TrendChart.tsx` / `DryRunPreview.tsx` 常數不動；補畫及格線 108（`scale.pass`）。
- `MemberScoreCell` / `TeamLeaderboard` / `ProfileEvaluation`：`insufficient_data` 列顯示「資料不足」badge 而非數字。
- section 明細（`ReportDetail`）：continuous section 顯示每個 signal 的 value、curve 區間、得分（分數可解釋性的主要載體）。

## 8. Migration 與 rollout（DECIDED：Phase 1–3 一次實作）

1. **Phase 1 — engine**：schema 擴充（`scale`、`scoring.mode`、`points`、`curve`、`minSamples`、`normalize`、`sampleCount`）+ `scoreSectionContinuous` + null/insufficient 語意 + `facet_user_satisfaction` signal + keyword 衛生修復（§6）+ 測試。
2. **Phase 2 — facet 管線**：extractor prompt 第 7 欄位 + facet 表 `user_satisfaction` 欄位（migration）+ facetWriter/facetCache 傳遞。
3. **Phase 3 — seed + DB/UI**：migration 寫入 v2.0.0 三語 rubric（org_id NULL、is_default 先 **false**）；`evaluation_reports.insufficient_data` 欄位；UI 及格線與資料不足狀態。
4. **校準後翻轉**：用 DryRunPreview 對全體成員近 30 天資料試跑，校準各 curve 參數；確認分布合理（預期 90–115 帶、非全員同分）後，另一支 migration 翻轉 is_default（v1 保留不刪，org 可自行 pin 回）。

風險備忘：facet extraction 依賴 `ENABLE_FACET_EXTRACTION` + per-org `llm_facet_enabled` + `llm_facet_model`——v2 生效前先確認 prod org 已開啟且 facet 覆蓋率足夠，否則全員「資料不足」。

## 9. Operator 決策（2026-07-13 定案）

| # | 決策點 | 定案 |
|---|---|---|
| 1 | 量表 | **保留 0–120**，及格線 108（= 季評分 90% 等值） |
| 2 | 需求方滿意維度 | **首發即加 `userSatisfaction` facet**（extractor + 欄位 + signal） |
| 3 | keyword 衛生修復（§6） | **做**，隨本案一起出 |
| 4 | 實作範圍 | **Phase 1–3 一次做完**；is_default 翻轉待校準 dry-run 通過後另出 migration |

## 10. Implementation notes（2026-07-13，13 tasks 完成後補記）

Branch `feat/rubric-v2-continuous-scoring`（worktree `.claude/worktrees/rubric-v2`）依 §8 Phase 1–3 一次實作完成，12 個實作 task + 本文件所屬的驗證/文件 task，逐 task code review 全部 Approved。與本設計文件的落差只有兩處，均在實作中發現並修正：

1. **`dispatchSignal` 未轉發 `normalize`**：Task 4（`ruleEngine` mode 分派）當時的程式碼漏寫 `normalize` 欄位轉發——本設計文件描述的 `facet_bugs_caught` / `facet_codex_errors` 的 `normalize: "per_session"` 語意在 T4 完工時實際上從未生效，等於用原始累計值（不除以 session 數）去跑 curve，直到 Task 9（platform v2 rubric 三語定義 + 分布性質測試）用真實分布回歸測試才抓到——高 session 數成員的 riskControl 分數被系統性拉低。已在 T9 review 修（`ruleEngine.ts` dispatchSignal 補轉發 `normalize`），並補一則 engine 測試鎖住行為（值 0.2，非累計值 4）。
2. **root CLI `src/admin-report.ts` 是未列在設計文件消費者清單裡的下游**：本文件 §3/§7 只提到 web UI（`MemberScoreCell`/`TeamLeaderboard`/`ProfileEvaluation`/`ReportDetail`）要處理 `insufficient_data` 顯示，沒提到獨立於 web 之外、直接讀 `Report`/`SectionResult` 型別的 root CLI 報表渲染器。`totalScore`/`section.score` 從 `number` 放寬成 `number | null` 後，`admin-report.ts` 對這兩個欄位的既有 `.toFixed(1)` 呼叫在 tsc 下直接編譯失敗（Task 7 migration 完工時發現）。已於 Task 8 補上 null-safe 分支（`totalScore === null ? "insufficient data" : …`、`section.score === null ? "—" : …`），行為與 web 端的「資料不足」badge 一致。
