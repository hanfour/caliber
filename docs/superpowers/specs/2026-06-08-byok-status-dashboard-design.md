# P3 — BYOK 用戶自助狀況/健康儀表板 設計

**日期：** 2026-06-08
**狀態：** 已核可，待寫實作計畫
**範圍：** BYOK 後續階段 P3（P1 user-scoped upstreams / P2 OAuth 自助 之外的第三塊；本 spec 不含 P2）

---

## 1. 目標

讓 BYOK 終端用戶在一個自助頁面看見「**自己**」的上游與使用狀況，無需 operator 介入：

1. **憑證健康/到期** — 自己註冊的上游憑證目前是否可用、OAuth 何時到期、最後一次錯誤。
2. **錯誤率/速率狀態** — 自己最近請求的錯誤比例（429／5xx）與上游速率限制狀態。
3. **即時活動/最近使用** — 自己最近的請求（次數／延遲／模型／成本）與最近 N 筆明細。

所有資料一律 **以呼叫者本人的 `userId` 為 scope**（只回呼叫者 authored 的列）。單組織部署下即等同「只看自己」；多組織情境下語意為「自己在任何組織的請求」，但**永不含他人資料**。

### 非目標（本期不做）

- 配額/預算使用量（`api_keys.quotaUsd`）— 留待後續。
- operator 全局/org 級總覽 — 本期只做用戶自視圖。
- 自動輪詢/即時推播 — 採進頁載入 + 手動重新整理。
- 把 Prometheus `gw_*` 指標暴露給前端 — 維持 :9464 內網私有。

---

## 2. 架構與資料流

新增 member-facing 頁 `/dashboard/status`，採**版面 A：由上而下堆疊**：

```
┌──────────────────────────────────────────┐
│ 狀況                       [重新整理]      │  ← 頁殼：標題 + 手動重新整理鈕
├──────────────────────────────────────────┤
│ ① 憑證健康/到期                            │  ← 每個自有上游一張卡
│   [claude-own  active  到期 12 天]         │
│   [openai-own  rate_limited  最後錯誤…]    │
├──────────────────────────────────────────┤
│ ② 錯誤率/速率：錯誤率 1.2% · 429×3 · 5xx×0 │  ← KPI 列
├──────────────────────────────────────────┤
│ ③ 最近活動：48 次 · $0.12 · 近 10 筆表     │  ← 摘要 + 最近請求表
└──────────────────────────────────────────┘
```

**資料流**：頁面掛載 → 三區塊各自獨立發 tRPC query（各自 loading / error / empty 狀態，互不阻塞）→ 頂部「重新整理」鈕呼叫 tRPC utils `invalidate()` 重抓三者。

**複用對照（方案 1：最大複用 + 一支新聚合）**

| 區塊 | 資料來源 | 後端改動 |
|------|----------|----------|
| ① 健康/到期 | 既有 `accounts.listOwn`（`.select()` 全欄）+ 前端 `deriveAccountStatus` | 無 |
| ② 錯誤率/速率 | **新增** `usage.errorSummary`（429/5xx 計數）+ ① 的 rate-limit 狀態 | 一支新端點 |
| ③ 即時活動 | 既有 `usage.summary` + `usage.list`（`scope:{type:"own"}`） | 無 |

**零 schema 變更**（不新增/修改任何資料表或欄位）。

---

## 3. 後端：唯一新端點 `usage.errorSummary`

加在現有 `apps/api/src/trpc/routers/usage.ts` 的 `usageRouter`，比照 `summary`/`list` 的既有樣式，複用同檔內的 `scopeWhere`、`resolveWindow`、`isoDateTime`、`ensureGatewayEnabled`。**差別**：本端點刻意**只接受 `own` scope**（不收 `user`/`team`/`org`），因為它是用戶自視圖；收緊 input 就從型別層關閉以特權 scope 呼叫的可能。

### 介面

```ts
errorSummary: protectedProcedure
  .input(
    z.object({
      // own-only：刻意只收 own。本頁是用戶自視圖，不需要也不應接受
      // user/team/org scope。input 收緊即為授權邊界（見 §7 INV-S2）。
      scope: z.object({ type: z.literal("own") }),
      from: isoDateTime.optional(),
      to: isoDateTime.optional(),
    }),
  )
  .query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);   // ENABLE_GATEWAY=false → NOT_FOUND

    const { from, to } = resolveWindow(input.from, input.to);
    const where = and(
      ...scopeWhere(input.scope, ctx.user.id),   // own → userId = caller
      gte(usageLogs.createdAt, from),
      lte(usageLogs.createdAt, to),
    );

    const [row] = await ctx.db
      .select({
        totalRequests: sql<number>`COUNT(*)::int`,
        errorRequests: sql<number>`COUNT(*) FILTER (WHERE ${usageLogs.statusCode} >= 400)::int`,
        count429: sql<number>`COUNT(*) FILTER (WHERE ${usageLogs.statusCode} = 429)::int`,
        count5xx: sql<number>`COUNT(*) FILTER (WHERE ${usageLogs.statusCode} >= 500)::int`,
      })
      .from(usageLogs)
      .where(where);

    return {
      totalRequests: row?.totalRequests ?? 0,
      errorRequests: row?.errorRequests ?? 0,
      count429: row?.count429 ?? 0,
      count5xx: row?.count5xx ?? 0,
    };
  }),
```

### 設計決定

- **錯誤率 % 由前端算**（`errorRequests / totalRequests`），避免 SQL 浮點格式化；`totalRequests = 0` 時前端顯示 `0%`。
- **預設視窗**：`resolveWindow` 既有預設（與 `summary` 一致）。本頁前端傳「過去 24h」的 `from`，明確界定錯誤率視窗。
- **授權邊界**：`usage.read_own` 在 RBAC 對任何已登入用戶皆回 `true`（見 `packages/auth/src/rbac/check.ts`），因此 own-only 端點不會、也不需要產生 `FORBIDDEN`。真正的守門是 `ensureGatewayEnabled`（`ENABLE_GATEWAY=false → NOT_FOUND`）+ input 只接受 `own` 把 scope 鎖死在呼叫者本人。
- **scope 過濾**：`scopeWhere(own)` 產生 `usageLogs.userId = caller.id`（無 orgId filter — 語意是「呼叫者本人 authored 的列」，見 §1 與 INV-S1）。
- `statusCode` 為 `NOT NULL` 整數欄（`packages/db/src/schema/usageLogs.ts`），`FILTER` 條件對每列都成立或不成立，無 NULL 邊界。

---

## 4. 前端檔案結構（多小檔、高內聚）

| 檔案 | 職責 |
|------|------|
| `apps/web/src/app/dashboard/status/page.tsx` | 頁殼：標題 + 重新整理鈕（呼叫 utils invalidate）+ 依序堆疊三區塊 |
| `apps/web/src/components/status/CredentialHealthSection.tsx` | ① 呼叫 `accounts.listOwn`，每筆渲染健康卡（名稱 + `StatusBadge` + 到期倒數 + 最後錯誤） |
| `apps/web/src/components/status/ErrorRateSection.tsx` | ② 呼叫 `usage.errorSummary`（own / 過去 24h），KPI 列：錯誤率 %、429、5xx |
| `apps/web/src/components/status/RecentActivitySection.tsx` | ③ 呼叫 `usage.summary` + `usage.list`（own，最近 10 筆），緊湊摘要 + 最近請求表 |
| `apps/web/src/components/status/ExpiryCountdown.tsx` | 小元件：`expiresAt` → 「12 天」/「已過期」/「—（無到期）」 |
| `apps/web/src/components/nav/Sidebar.tsx`（修改） | 新增 nav `{ href:'/dashboard/status', labelKey:'status', icon: Activity, visible:(p)=>p.hasOrg }` |
| `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`（修改） | 新增 `status.*` namespace + `nav.items.status` |

### 元件複用

- `deriveAccountStatus` / `StatusBadge`：自 `@/components/accounts/status` 匯入。`listOwn` 回傳的 row 結構上滿足 `AccountStatusInput`（含 `schedulable`/`rateLimitedAt`/`rateLimitResetAt`/`overloadUntil`/`tempUnschedulableUntil`/`expiresAt`/`errorMessage`/`status`），直接傳入免轉型。
- tRPC client：`trpc` from `@/lib/trpc/client`；型別用 `inferRouterOutputs<AppRouter>`。
- 沿用既有 native `<select>`/table 樣式（專案無 Select/Table primitive）。

### 重新整理機制

頁殼「重新整理」鈕呼叫 tRPC utils：`utils.accounts.listOwn.invalidate()` + `utils.usage.errorSummary.invalidate()` + `utils.usage.summary.invalidate()` + `utils.usage.list.invalidate()`。三區塊各自 query 重抓，獨立呈現載入狀態。

---

## 5. 錯誤處理與狀態

每區塊獨立處理三態：

- **載入中**：骨架/「載入中…」。
- **錯誤**：user-friendly 訊息（如「無法載入健康狀態，請稍後重試」），不洩漏內部細節。
- **空狀態**：
  - ① 無自有上游 → 「你尚未登錄任何上游憑證」+ 連到 `/dashboard/upstreams`。
  - ② 無使用紀錄 → 錯誤率顯示 `0%`、429/5xx 顯示 `0`。
  - ③ 無使用紀錄 → 「尚無使用紀錄」。

到期倒數：`expiresAt` 為 NULL（api_key 型上游無到期）→ 顯示「—」；已過 → 「已過期」並標紅。

---

## 6. 測試（TDD，必加，目標 80%+）

### 後端 — `usage.errorSummary`（integration，比照既有 usage router 測試）

- 429/5xx/4xx/2xx 計數正確：構造混合 statusCode 的 usage_logs，斷言四個計數值（含 4xx 非 429 計入 errorRequests 但不計 count429/count5xx）。
- **用戶隔離**：`scope:{type:"own"}` 只計 caller 自己的列 — 插入他人 `userId` 的列（含錯誤狀態），斷言不被計入任何計數。
- **gateway 守門**：`ENABLE_GATEWAY=false` → `NOT_FOUND`（`ensureGatewayEnabled`）。
- 時間視窗過濾：視窗外的列不計入。
- 空窗 → 全 0（不丟 null）。

### 前端（Vitest + Testing Library，`vi.mock("@/lib/trpc/client")`）

- `CredentialHealthSection`：渲染 active / expired / rate_limited / error 各狀態的 badge；空態顯示連到 upstreams 的提示。
- `ErrorRateSection`：渲染錯誤率 %（含 totalRequests=0 → 0%）、429、5xx。
- `RecentActivitySection`：渲染最近筆數摘要 + 表列；空態顯示「尚無使用紀錄」。
- `status/page`：渲染三區塊 + 重新整理鈕；點鈕觸發 utils invalidate（mock 斷言被呼叫）。
- `ExpiryCountdown`：NULL → 「—」；未來 → 天數；過去 → 「已過期」。

---

## 7. 不變式與安全

- **INV-S1：用戶隔離** — 三區塊所有查詢一律 scope 到 `caller.userId`（① `listOwn` 的 `userId=ctx.user.id`；②③ 的 `scopeWhere(own)` = `userId=caller`）。任何區塊都不得回傳他人資料。
- **INV-S2：scope 鎖死於本人** — ② `errorSummary` 的 input 只接受 `{type:"own"}`，型別層即排除 `user`/`team`/`org` scope；`scopeWhere(own)` 再把列限制在 `userId=caller`。授權邊界靠 input 收緊 + `ensureGatewayEnabled`，而非 RBAC（`usage.read_own` 對任何登入者皆 true，無法當守門）。
- **INV-S3：零 schema** — 不新增/改動資料表；純讀取既有 `upstream_accounts` 與 `usage_logs`。
- 錯誤訊息不洩漏內部憑證內容或他租戶資訊。

---

## 8. 預設值（可於實作計畫前再調）

| 項目 | 預設 |
|------|------|
| 錯誤率視窗 | 過去 24h |
| 最近活動筆數 | 10 |
| nav 圖示 / label | `Activity` /「狀況」 |
| 頁路由 | `/dashboard/status` |
