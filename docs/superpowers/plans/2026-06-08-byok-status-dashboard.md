# P3 — BYOK 用戶自助狀況/健康儀表板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 member-facing `/dashboard/status` 頁，讓 BYOK 用戶看見「自己」的上游憑證健康/到期、錯誤率/速率、最近活動，全部 scope 到呼叫者 userId。

**Architecture:** 後端只加一支 own-only `usage.errorSummary`（429/5xx 計數）；① 憑證健康複用 `accounts.listOwn` + 前端 `deriveAccountStatus`，③ 活動複用 `usage.summary`/`usage.list`（scope own）。前端版面 A（由上而下堆疊），進頁載入 + 手動重新整理（tRPC utils invalidate）。零 schema 變更。

**Tech Stack:** tRPC (protectedProcedure) + Drizzle + Postgres `COUNT(*) FILTER`；Next.js App Router + next-intl（5 catalogs）+ Vitest/Testing Library；後端 integration test 用 setupTestDb factories。

**Spec:** `docs/superpowers/specs/2026-06-08-byok-status-dashboard-design.md`

---

## File Structure

| 檔案 | 職責 | 動作 |
|------|------|------|
| `apps/api/src/trpc/routers/usage.ts` | 加 `errorSummary` procedure | Modify |
| `apps/api/tests/integration/trpc/usage.test.ts` | `SeedRow.statusCode` + errorSummary 測試 | Modify |
| `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` | `status.*` namespace + `nav.items.status` | Modify |
| `apps/web/src/components/status/ExpiryCountdown.tsx` | `expiresAt` → 倒數/已過期/— | Create |
| `apps/web/src/components/status/CredentialHealthSection.tsx` | ① 健康表（listOwn + StatusBadge + ExpiryCountdown） | Create |
| `apps/web/src/components/status/ErrorRateSection.tsx` | ② errorSummary KPI（24h） | Create |
| `apps/web/src/components/status/RecentActivitySection.tsx` | ③ summary + list（own, 最近 10） | Create |
| `apps/web/src/app/dashboard/status/page.tsx` | 頁殼 + 重新整理鈕 + 堆疊三區塊 | Create |
| `apps/web/src/components/nav/Sidebar.tsx` | nav `status` 入口 | Modify |
| `apps/web/tests/components/status/*.test.tsx` | 各區塊 + 頁 + ExpiryCountdown 測試 | Create |

**執行順序：** Task 1（後端）→ Task 2（i18n，必須在前端元件測試前）→ Task 3 ExpiryCountdown → Task 4 Health → Task 5 ErrorRate → Task 6 Activity → Task 7 Page + nav。

---

## Task 1: 後端 `usage.errorSummary` 端點

**Files:**
- Modify: `apps/api/tests/integration/trpc/usage.test.ts`（`SeedRow` + `insertUsageRow` + 新 describe）
- Modify: `apps/api/src/trpc/routers/usage.ts`（在 `list` 之後加 `errorSummary`）

- [ ] **Step 1: 擴充測試 seed helper 支援 statusCode**

在 `apps/api/tests/integration/trpc/usage.test.ts` 的 `interface SeedRow` 末尾（`createdAt?: Date;` 之前/後）加一欄：

```ts
  statusCode?: number;
```

並把 `insertUsageRow` 內寫死的 `statusCode: 200,` 改成：

```ts
    statusCode: opts.statusCode ?? 200,
```

- [ ] **Step 2: 寫失敗測試（errorSummary）**

在 `usage.test.ts` 檔尾、`describe("usage router", () => { ... })` 之後，新增獨立 describe：

```ts
describe("usage.errorSummary", () => {
  it("counts 4xx/429/5xx for the caller and ignores other users", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const b = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const account = await seedAccount(t.db, org.id);
    const aKey = await seedApiKey(t.db, { userId: a.id, orgId: org.id });
    const bKey = await seedApiKey(t.db, { userId: b.id, orgId: org.id });

    // A: 200, 200, 429, 500, 403 → total 5, errors 3 (429+500+403), 429×1, 5xx×1
    for (const code of [200, 200, 429, 500, 403]) {
      await insertUsageRow(t.db, { userId: a.id, apiKeyId: aKey, accountId: account, orgId: org.id, statusCode: code });
    }
    // B: a 500 that must NOT be counted for A
    await insertUsageRow(t.db, { userId: b.id, apiKeyId: bKey, accountId: account, orgId: org.id, statusCode: 500 });

    const callerA = await callerFor({ db: t.db, userId: a.id });
    const res = await callerA.usage.errorSummary({ scope: { type: "own" } });

    expect(res.totalRequests).toBe(5);
    expect(res.errorRequests).toBe(3);
    expect(res.count429).toBe(1);
    expect(res.count5xx).toBe(1);
  });

  it("returns all-zero for an empty window", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id });
    const res = await caller.usage.errorSummary({ scope: { type: "own" } });
    expect(res).toEqual({ totalRequests: 0, errorRequests: 0, count429: 0, count5xx: 0 });
  });

  it("excludes rows outside the default 30-day window", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: u.id, orgId: org.id });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40d ago; default window is 30d
    await insertUsageRow(t.db, { userId: u.id, apiKeyId: key, accountId: account, orgId: org.id, statusCode: 500, createdAt: old });
    const caller = await callerFor({ db: t.db, userId: u.id });
    const res = await caller.usage.errorSummary({ scope: { type: "own" } });
    expect(res.totalRequests).toBe(0);
  });

  it("throws NOT_FOUND when the gateway is disabled", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, env: { ...defaultTestEnv, ENABLE_GATEWAY: false } });
    await expect(caller.usage.errorSummary({ scope: { type: "own" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `pnpm --filter @caliber/api test -- usage.test.ts`
Expected: FAIL（`callerA.usage.errorSummary is not a function` / 型別錯誤）。

- [ ] **Step 4: 實作 `errorSummary`**

在 `apps/api/src/trpc/routers/usage.ts` 的 `usageRouter` 內、`list:` procedure 之後（`})` 收尾前）加：

```ts
  // Error-rate counters over a window for the caller's OWN requests. Powers the
  // self-service status dashboard (P3). own-only by design: the input refuses
  // user/team/org scope, so the row set is locked to the caller via
  // scopeWhere(own). status_code is NOT NULL, so every row lands in exactly
  // one FILTER bucket or none. Authorization boundary is (a) protectedProcedure,
  // (b) own-only input + scopeWhere, (c) ensureGatewayEnabled — NOT RBAC
  // (usage.read_own returns true for every authenticated user).
  errorSummary: protectedProcedure
    .input(
      z.object({
        scope: z.object({ type: z.literal("own") }),
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);

      const { from, to } = resolveWindow(input.from, input.to);
      const where = and(
        ...scopeWhere(input.scope, ctx.user.id),
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

- [ ] **Step 5: 跑測試確認通過**

Run: `pnpm --filter @caliber/api test -- usage.test.ts`
Expected: PASS（含既有 summary/list 測試 + 4 個新 errorSummary 測試）。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/usage.ts apps/api/tests/integration/trpc/usage.test.ts
git commit -m "feat(api): own-only usage.errorSummary for status dashboard"
```

---

## Task 2: i18n — `status.*` namespace + `nav.items.status`

**Files:**
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh-TW.json`
- Modify: `apps/web/messages/zh-CN.json`
- Modify: `apps/web/messages/ja.json`
- Modify: `apps/web/messages/ko.json`

> 無測試步驟（純資料）。但這是後續所有前端元件測試的前置：測試 setup（`apps/web/tests/setup.ts`）把 `next-intl` stub 到 `en.json`，缺 key 會讓 `t('...')` 回傳原始 key path 而非文字，斷言會失敗。**必須在 Task 3–7 之前完成。**

- [ ] **Step 1: en.json 加 `status` namespace**

在 `apps/web/messages/en.json` 頂層加入（與 `upstreams` 同層）：

```json
"status": {
  "pageTitle": "Status",
  "pageSubtitle": "Health and recent activity for your own upstreams and usage.",
  "refresh": "Refresh",
  "health": {
    "title": "Credential health",
    "description": "Status and expiry of the upstreams you registered.",
    "empty": "You haven't registered any upstream credentials yet.",
    "manageLink": "Manage upstreams",
    "colName": "Name",
    "colStatus": "Status",
    "colExpiry": "Expiry",
    "colError": "Last error",
    "loadError": "Couldn't load credential health. Please try again."
  },
  "errorRate": {
    "title": "Error rate",
    "description": "Errors across your requests in the last 24 hours.",
    "rate": "Error rate",
    "count429": "Rate-limited (429)",
    "count5xx": "Server errors (5xx)",
    "loadError": "Couldn't load error stats. Please try again."
  },
  "activity": {
    "title": "Recent activity",
    "description": "Your most recent requests.",
    "empty": "No usage recorded yet.",
    "summary": "{requests} requests · ${cost}",
    "colTime": "Time",
    "colSurface": "Surface",
    "colModel": "Model",
    "colStatus": "Status",
    "colLatency": "Latency",
    "colCost": "Cost",
    "loadError": "Couldn't load recent activity. Please try again."
  },
  "expiry": {
    "none": "—",
    "expired": "Expired",
    "days": "{days}d"
  }
}
```

並在 `nav.items` 物件內加一行：`"status": "Status"`。

- [ ] **Step 2: zh-TW.json 加對應翻譯**

`status` namespace：

```json
"status": {
  "pageTitle": "狀況",
  "pageSubtitle": "你自己的上游與使用的健康狀況與最近活動。",
  "refresh": "重新整理",
  "health": {
    "title": "憑證健康",
    "description": "你登錄的上游的狀態與到期。",
    "empty": "你尚未登錄任何上游憑證。",
    "manageLink": "管理上游",
    "colName": "名稱",
    "colStatus": "狀態",
    "colExpiry": "到期",
    "colError": "最後錯誤",
    "loadError": "無法載入憑證健康，請稍後重試。"
  },
  "errorRate": {
    "title": "錯誤率",
    "description": "過去 24 小時你請求的錯誤。",
    "rate": "錯誤率",
    "count429": "速率限制 (429)",
    "count5xx": "伺服器錯誤 (5xx)",
    "loadError": "無法載入錯誤統計，請稍後重試。"
  },
  "activity": {
    "title": "最近活動",
    "description": "你最近的請求。",
    "empty": "尚無使用紀錄。",
    "summary": "{requests} 次請求 · ${cost}",
    "colTime": "時間",
    "colSurface": "介面",
    "colModel": "模型",
    "colStatus": "狀態",
    "colLatency": "延遲",
    "colCost": "成本",
    "loadError": "無法載入最近活動，請稍後重試。"
  },
  "expiry": {
    "none": "—",
    "expired": "已過期",
    "days": "{days} 天"
  }
}
```

`nav.items` 加 `"status": "狀況"`。

- [ ] **Step 3: zh-CN.json 加對應翻譯**

```json
"status": {
  "pageTitle": "状态",
  "pageSubtitle": "你自己的上游与使用的健康状况与最近活动。",
  "refresh": "刷新",
  "health": {
    "title": "凭证健康",
    "description": "你登记的上游的状态与到期。",
    "empty": "你尚未登记任何上游凭证。",
    "manageLink": "管理上游",
    "colName": "名称",
    "colStatus": "状态",
    "colExpiry": "到期",
    "colError": "最近错误",
    "loadError": "无法加载凭证健康，请稍后重试。"
  },
  "errorRate": {
    "title": "错误率",
    "description": "过去 24 小时你请求的错误。",
    "rate": "错误率",
    "count429": "速率限制 (429)",
    "count5xx": "服务器错误 (5xx)",
    "loadError": "无法加载错误统计，请稍后重试。"
  },
  "activity": {
    "title": "最近活动",
    "description": "你最近的请求。",
    "empty": "尚无使用记录。",
    "summary": "{requests} 次请求 · ${cost}",
    "colTime": "时间",
    "colSurface": "接口",
    "colModel": "模型",
    "colStatus": "状态",
    "colLatency": "延迟",
    "colCost": "成本",
    "loadError": "无法加载最近活动，请稍后重试。"
  },
  "expiry": {
    "none": "—",
    "expired": "已过期",
    "days": "{days} 天"
  }
}
```

`nav.items` 加 `"status": "状态"`。

- [ ] **Step 4: ja.json 加對應翻譯**

```json
"status": {
  "pageTitle": "ステータス",
  "pageSubtitle": "自分のアップストリームと利用状況の健全性と最近のアクティビティ。",
  "refresh": "更新",
  "health": {
    "title": "認証情報の健全性",
    "description": "登録したアップストリームのステータスと有効期限。",
    "empty": "アップストリームの認証情報がまだ登録されていません。",
    "manageLink": "アップストリームを管理",
    "colName": "名前",
    "colStatus": "ステータス",
    "colExpiry": "有効期限",
    "colError": "最後のエラー",
    "loadError": "認証情報の健全性を読み込めませんでした。再試行してください。"
  },
  "errorRate": {
    "title": "エラー率",
    "description": "過去 24 時間のリクエストのエラー。",
    "rate": "エラー率",
    "count429": "レート制限 (429)",
    "count5xx": "サーバーエラー (5xx)",
    "loadError": "エラー統計を読み込めませんでした。再試行してください。"
  },
  "activity": {
    "title": "最近のアクティビティ",
    "description": "直近のリクエスト。",
    "empty": "利用記録はまだありません。",
    "summary": "{requests} 件のリクエスト · ${cost}",
    "colTime": "時刻",
    "colSurface": "サーフェス",
    "colModel": "モデル",
    "colStatus": "ステータス",
    "colLatency": "レイテンシ",
    "colCost": "コスト",
    "loadError": "最近のアクティビティを読み込めませんでした。再試行してください。"
  },
  "expiry": {
    "none": "—",
    "expired": "期限切れ",
    "days": "{days}日"
  }
}
```

`nav.items` 加 `"status": "ステータス"`。

- [ ] **Step 5: ko.json 加對應翻譯**

```json
"status": {
  "pageTitle": "상태",
  "pageSubtitle": "내 업스트림과 사용량의 상태 및 최근 활동.",
  "refresh": "새로고침",
  "health": {
    "title": "자격 증명 상태",
    "description": "등록한 업스트림의 상태와 만료.",
    "empty": "아직 등록한 업스트림 자격 증명이 없습니다.",
    "manageLink": "업스트림 관리",
    "colName": "이름",
    "colStatus": "상태",
    "colExpiry": "만료",
    "colError": "마지막 오류",
    "loadError": "자격 증명 상태를 불러오지 못했습니다. 다시 시도해 주세요."
  },
  "errorRate": {
    "title": "오류율",
    "description": "지난 24시간 동안의 요청 오류.",
    "rate": "오류율",
    "count429": "속도 제한 (429)",
    "count5xx": "서버 오류 (5xx)",
    "loadError": "오류 통계를 불러오지 못했습니다. 다시 시도해 주세요."
  },
  "activity": {
    "title": "최근 활동",
    "description": "가장 최근 요청.",
    "empty": "아직 사용 기록이 없습니다.",
    "summary": "{requests}건 요청 · ${cost}",
    "colTime": "시간",
    "colSurface": "서피스",
    "colModel": "모델",
    "colStatus": "상태",
    "colLatency": "지연",
    "colCost": "비용",
    "loadError": "최근 활동을 불러오지 못했습니다. 다시 시도해 주세요."
  },
  "expiry": {
    "none": "—",
    "expired": "만료됨",
    "days": "{days}일"
  }
}
```

`nav.items` 加 `"status": "상태"`。

- [ ] **Step 6: 驗證 5 個 JSON 合法且 key 對齊**

Run: `node -e "for(const l of ['en','zh-TW','zh-CN','ja','ko']){const j=require('./apps/web/messages/'+l+'.json'); if(!j.status||!j.status.health||!j.nav.items.status) throw new Error('missing status keys in '+l); } console.log('ok')"`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add apps/web/messages/en.json apps/web/messages/zh-TW.json apps/web/messages/zh-CN.json apps/web/messages/ja.json apps/web/messages/ko.json
git commit -m "i18n(web): status dashboard namespace + nav entry (5 locales)"
```

---

## Task 3: `ExpiryCountdown` 元件

**Files:**
- Create: `apps/web/src/components/status/ExpiryCountdown.tsx`
- Test: `apps/web/tests/components/status/ExpiryCountdown.test.tsx`

- [ ] **Step 1: 寫失敗測試**

`apps/web/tests/components/status/ExpiryCountdown.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExpiryCountdown } from "@/components/status/ExpiryCountdown";

describe("ExpiryCountdown", () => {
  it("renders an em dash when expiresAt is null (no expiry)", () => {
    render(<ExpiryCountdown expiresAt={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders 'Expired' when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<ExpiryCountdown expiresAt={past} />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("renders a day countdown when expiresAt is in the future", () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 1000).toISOString();
    render(<ExpiryCountdown expiresAt={future} />);
    // Math.ceil of just-over-5-days → "5d"
    expect(screen.getByText("5d")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/web test -- ExpiryCountdown`
Expected: FAIL（`Cannot find module '@/components/status/ExpiryCountdown'`）。

- [ ] **Step 3: 實作元件**

`apps/web/src/components/status/ExpiryCountdown.tsx`：

```tsx
"use client";

import { useTranslations } from "next-intl";
import { toDate } from "@/lib/time";

// Renders an upstream credential's expiry as a short countdown.
// null  → "—"  (api_key upstreams have no expiry)
// past  → "Expired" (rose)
// future → "{days}d" where days = ceil(remaining / 1 day)
export function ExpiryCountdown({ expiresAt }: { expiresAt: Date | string | null }) {
  const t = useTranslations("status.expiry");
  const d = toDate(expiresAt);
  if (!d) return <span className="text-muted-foreground">{t("none")}</span>;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0)
    return <span className="text-rose-600 dark:text-rose-400">{t("expired")}</span>;
  const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return <span>{t("days", { days })}</span>;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/web test -- ExpiryCountdown`
Expected: PASS（3/3）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/status/ExpiryCountdown.tsx apps/web/tests/components/status/ExpiryCountdown.test.tsx
git commit -m "feat(web): ExpiryCountdown component for status dashboard"
```

---

## Task 4: `CredentialHealthSection` 元件（①）

**Files:**
- Create: `apps/web/src/components/status/CredentialHealthSection.tsx`
- Test: `apps/web/tests/components/status/CredentialHealthSection.test.tsx`

> 複用既有 `accounts.listOwn`（回傳全欄，結構滿足 `AccountStatusInput`）+ `deriveAccountStatus`/`StatusBadge`（讀 `common.*` 既有狀態文字）+ `ExpiryCountdown`。

- [ ] **Step 1: 寫失敗測試**

`apps/web/tests/components/status/CredentialHealthSection.test.tsx`（mock 樣式比照 `tests/components/upstreams/UpstreamOwnList.test.tsx`）：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const listOwnQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    accounts: { listOwn: { useQuery: (...a: unknown[]) => listOwnQuery(...a) } },
  },
}));
import { CredentialHealthSection } from "@/components/status/CredentialHealthSection";

const baseRow = {
  id: "a1", name: "My key", platform: "anthropic", type: "api_key", priority: 50,
  schedulable: true, status: "active", rateLimitedAt: null, rateLimitResetAt: null,
  overloadUntil: null, tempUnschedulableUntil: null, expiresAt: null, errorMessage: null,
  createdAt: "2026-06-08T00:00:00Z", lastUsedAt: null,
};

describe("CredentialHealthSection", () => {
  it("shows the empty hint with a manage-upstreams link when there are none", () => {
    listOwnQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<CredentialHealthSection />);
    expect(screen.getByText("You haven't registered any upstream credentials yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage upstreams" })).toHaveAttribute("href", "/dashboard/upstreams");
  });

  it("renders a healthy upstream row with an Active badge", () => {
    listOwnQuery.mockReturnValue({ data: [baseRow], isLoading: false, error: null });
    render(<CredentialHealthSection />);
    expect(screen.getByText("My key")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders Expired status + expiry cell for an expired OAuth upstream", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    listOwnQuery.mockReturnValue({
      data: [{ ...baseRow, type: "oauth", expiresAt: past }],
      isLoading: false, error: null,
    });
    render(<CredentialHealthSection />);
    // deriveAccountStatus → "expired" → common.expired = "Expired" (badge),
    // ExpiryCountdown → "Expired" too. Both present → at least 2 matches.
    expect(screen.getAllByText("Expired").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the section error message when the query errors", () => {
    listOwnQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<CredentialHealthSection />);
    expect(screen.getByText("Couldn't load credential health. Please try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/web test -- CredentialHealthSection`
Expected: FAIL（`Cannot find module '@/components/status/CredentialHealthSection'`）。

- [ ] **Step 3: 實作元件**

`apps/web/src/components/status/CredentialHealthSection.tsx`：

```tsx
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveAccountStatus, StatusBadge } from "@/components/accounts/status";
import { ExpiryCountdown } from "./ExpiryCountdown";

type UpstreamRow = inferRouterOutputs<AppRouter>["accounts"]["listOwn"][number];

export function CredentialHealthSection() {
  const t = useTranslations("status.health");
  const tCommon = useTranslations("common");
  const { data, isLoading, error } = trpc.accounts.listOwn.useQuery();

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("empty")}{" "}
            <Link href="/dashboard/upstreams" className="text-primary underline">
              {t("manageLink")}
            </Link>
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colName")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colExpiry")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colError")}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row: UpstreamRow) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2"><StatusBadge status={deriveAccountStatus(row)} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      <ExpiryCountdown expiresAt={row.expiresAt} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/web test -- CredentialHealthSection`
Expected: PASS（4/4）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/status/CredentialHealthSection.tsx apps/web/tests/components/status/CredentialHealthSection.test.tsx
git commit -m "feat(web): CredentialHealthSection for status dashboard"
```

---

## Task 5: `ErrorRateSection` 元件（②）

**Files:**
- Create: `apps/web/src/components/status/ErrorRateSection.tsx`
- Test: `apps/web/tests/components/status/ErrorRateSection.test.tsx`

> 呼叫新 `usage.errorSummary`，input `{ scope:{type:"own"}, from: <now-24h ISO> }`。錯誤率 % 在前端算（`errorRequests/totalRequests`，total=0 → 0%）。

- [ ] **Step 1: 寫失敗測試**

`apps/web/tests/components/status/ErrorRateSection.test.tsx`：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const errorSummaryQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    usage: { errorSummary: { useQuery: (...a: unknown[]) => errorSummaryQuery(...a) } },
  },
}));
import { ErrorRateSection } from "@/components/status/ErrorRateSection";

describe("ErrorRateSection", () => {
  it("renders 0% with zero counts for an empty window", () => {
    errorSummaryQuery.mockReturnValue({
      data: { totalRequests: 0, errorRequests: 0, count429: 0, count5xx: 0 },
      isLoading: false, error: null,
    });
    render(<ErrorRateSection />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("computes the error-rate percentage from counts", () => {
    errorSummaryQuery.mockReturnValue({
      data: { totalRequests: 50, errorRequests: 5, count429: 3, count5xx: 2 },
      isLoading: false, error: null,
    });
    render(<ErrorRateSection />);
    expect(screen.getByText("10%")).toBeInTheDocument(); // 5/50
    expect(screen.getByText("3")).toBeInTheDocument();   // 429
    expect(screen.getByText("2")).toBeInTheDocument();   // 5xx
  });

  it("renders the section error message when the query errors", () => {
    errorSummaryQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<ErrorRateSection />);
    expect(screen.getByText("Couldn't load error stats. Please try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/web test -- ErrorRateSection`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作元件**

`apps/web/src/components/status/ErrorRateSection.tsx`：

```tsx
"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Look back 24h for the error-rate window. Computed once per render; the value
// only needs day-resolution so a per-render Date is fine (no memoization).
function since24h(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function pct(errorRequests: number, totalRequests: number): string {
  if (totalRequests <= 0) return "0%";
  return `${Math.round((errorRequests / totalRequests) * 100)}%`;
}

export function ErrorRateSection() {
  const t = useTranslations("status.errorRate");
  const tCommon = useTranslations("common");
  const { data, isLoading, error } = trpc.usage.errorSummary.useQuery({
    scope: { type: "own" },
    from: since24h(),
  });

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error || !data ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{pct(data.errorRequests, data.totalRequests)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("rate")}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{data.count429}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("count429")}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{data.count5xx}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("count5xx")}</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/web test -- ErrorRateSection`
Expected: PASS（3/3）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/status/ErrorRateSection.tsx apps/web/tests/components/status/ErrorRateSection.test.tsx
git commit -m "feat(web): ErrorRateSection for status dashboard"
```

---

## Task 6: `RecentActivitySection` 元件（③）

**Files:**
- Create: `apps/web/src/components/status/RecentActivitySection.tsx`
- Test: `apps/web/tests/components/status/RecentActivitySection.test.tsx`

> 呼叫既有 `usage.summary`（own，摘要行）+ `usage.list`（own，`page:1, pageSize:10`，最近 10 筆）。`usage.list` row 欄位見 `usage.ts` 的 `listColumns`（`createdAt`/`surface`/`requestedModel`/`statusCode`/`durationMs`/`totalCost`）。

- [ ] **Step 1: 寫失敗測試**

`apps/web/tests/components/status/RecentActivitySection.test.tsx`：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const summaryQuery = vi.fn();
const listQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    usage: {
      summary: { useQuery: (...a: unknown[]) => summaryQuery(...a) },
      list: { useQuery: (...a: unknown[]) => listQuery(...a) },
    },
  },
}));
import { RecentActivitySection } from "@/components/status/RecentActivitySection";

const summaryData = {
  totalRequests: 48, totalCostUsd: "0.1200000000", totalInputTokens: 0,
  totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, byModel: [],
};
const listRow = {
  id: "u1", requestId: "r1", userId: "me", apiKeyId: "k1", accountId: "ac1",
  orgId: "o1", teamId: null, requestedModel: "claude-sonnet-4-5", upstreamModel: "x",
  platform: "anthropic", surface: "messages", inputTokens: 10, outputTokens: 20,
  cacheCreationTokens: 0, cacheReadTokens: 0, inputCost: "0", outputCost: "0",
  cacheCreationCost: "0", cacheReadCost: "0", totalCost: "0.0030000000", stream: false,
  statusCode: 200, durationMs: 1400, firstTokenMs: null, bufferReleasedAtMs: null,
  upstreamRetries: 0, createdAt: "2026-06-08T14:02:00Z",
};

describe("RecentActivitySection", () => {
  it("shows the empty state when there is no usage", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: { items: [], page: 1, pageSize: 10, totalCount: 0 }, isLoading: false, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("No usage recorded yet.")).toBeInTheDocument();
  });

  it("renders a recent request row with its model and status code", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: { items: [listRow], page: 1, pageSize: 10, totalCount: 1 }, isLoading: false, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("renders the section error message when the list query errors", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<RecentActivitySection />);
    expect(screen.getByText("Couldn't load recent activity. Please try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/web test -- RecentActivitySection`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作元件**

`apps/web/src/components/status/RecentActivitySection.tsx`：

```tsx
"use client";

import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { toDate } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ListRow = inferRouterOutputs<AppRouter>["usage"]["list"]["items"][number];

const RECENT_LIMIT = 10;

function formatTime(ts: Date | string | null): string {
  const d = toDate(ts);
  return d ? d.toLocaleString() : "—";
}

export function RecentActivitySection() {
  const t = useTranslations("status.activity");
  const tCommon = useTranslations("common");
  const summary = trpc.usage.summary.useQuery({ scope: { type: "own" } });
  const list = trpc.usage.list.useQuery({ scope: { type: "own" }, page: 1, pageSize: RECENT_LIMIT });

  const items: ListRow[] = list.data?.items ?? [];

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {summary.data ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("summary", { requests: summary.data.totalRequests, cost: summary.data.totalCostUsd })}
          </p>
        ) : null}
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : list.error || !list.data ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colTime")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colSurface")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colModel")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("colLatency")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("colCost")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row: ListRow) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatTime(row.createdAt)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.surface}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.requestedModel}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.statusCode}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">{row.durationMs}ms</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">${row.totalCost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/web test -- RecentActivitySection`
Expected: PASS（3/3）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/status/RecentActivitySection.tsx apps/web/tests/components/status/RecentActivitySection.test.tsx
git commit -m "feat(web): RecentActivitySection for status dashboard"
```

---

## Task 7: `/dashboard/status` 頁殼 + 重新整理 + Sidebar nav

**Files:**
- Create: `apps/web/src/app/dashboard/status/page.tsx`
- Modify: `apps/web/src/components/nav/Sidebar.tsx`
- Test: `apps/web/tests/components/status/StatusPage.test.tsx`

> 頁殼堆疊三區塊（順序：健康 → 錯誤率 → 活動），頂部「重新整理」鈕呼叫 `trpc.useUtils()` 對四個 query invalidate。

- [ ] **Step 1: 寫失敗測試（頁殼）**

`apps/web/tests/components/status/StatusPage.test.tsx`（mock 三區塊子元件 + utils，聚焦頁殼組裝與重新整理鈕）：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const invalidateHealth = vi.fn();
const invalidateError = vi.fn();
const invalidateSummary = vi.fn();
const invalidateList = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      accounts: { listOwn: { invalidate: invalidateHealth } },
      usage: {
        errorSummary: { invalidate: invalidateError },
        summary: { invalidate: invalidateSummary },
        list: { invalidate: invalidateList },
      },
    }),
  },
}));
vi.mock("@/components/status/CredentialHealthSection", () => ({
  CredentialHealthSection: () => <div data-testid="health-section" />,
}));
vi.mock("@/components/status/ErrorRateSection", () => ({
  ErrorRateSection: () => <div data-testid="error-section" />,
}));
vi.mock("@/components/status/RecentActivitySection", () => ({
  RecentActivitySection: () => <div data-testid="activity-section" />,
}));
import StatusPage from "@/app/dashboard/status/page";

describe("StatusPage", () => {
  it("renders the three sections", () => {
    render(<StatusPage />);
    expect(screen.getByTestId("health-section")).toBeInTheDocument();
    expect(screen.getByTestId("error-section")).toBeInTheDocument();
    expect(screen.getByTestId("activity-section")).toBeInTheDocument();
  });

  it("invalidates all four queries when Refresh is clicked", () => {
    render(<StatusPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(invalidateHealth).toHaveBeenCalledTimes(1);
    expect(invalidateError).toHaveBeenCalledTimes(1);
    expect(invalidateSummary).toHaveBeenCalledTimes(1);
    expect(invalidateList).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @caliber/web test -- StatusPage`
Expected: FAIL（`Cannot find module '@/app/dashboard/status/page'`）。

- [ ] **Step 3: 實作頁殼**

`apps/web/src/app/dashboard/status/page.tsx`：

```tsx
"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { CredentialHealthSection } from "@/components/status/CredentialHealthSection";
import { ErrorRateSection } from "@/components/status/ErrorRateSection";
import { RecentActivitySection } from "@/components/status/RecentActivitySection";

export default function StatusPage() {
  const t = useTranslations("status");
  const utils = trpc.useUtils();

  const handleRefresh = () => {
    utils.accounts.listOwn.invalidate();
    utils.usage.errorSummary.invalidate();
    utils.usage.summary.invalidate();
    utils.usage.list.invalidate();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("pageTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageSubtitle")}</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4" />
          {t("refresh")}
        </Button>
      </div>
      <CredentialHealthSection />
      <ErrorRateSection />
      <RecentActivitySection />
    </div>
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @caliber/web test -- StatusPage`
Expected: PASS（2/2）。

- [ ] **Step 5: Sidebar 加 nav 入口**

在 `apps/web/src/components/nav/Sidebar.tsx`：

(a) import 加 `Activity`：

```tsx
import {
  LayoutDashboard,
  Building2,
  Users,
  UserPlus,
  FileText,
  UserCircle,
  Laptop,
  KeyRound,
  Activity
} from 'lucide-react'
```

(b) `NavItemKey` union 末尾加 `| 'status'`：

```tsx
type NavItemKey =
  | 'dashboard' | 'organizations' | 'teams' | 'invites' | 'auditLog' | 'profile' | 'devices' | 'upstreams' | 'status'
```

(c) 在 `overview` section 的 items 陣列裡、`dashboard` 之後加一行：

```tsx
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard, visible: () => true },
      { href: '/dashboard/status', labelKey: 'status', icon: Activity, visible: (p) => p.hasOrg }
```

- [ ] **Step 6: 跑整包 web 測試確認無回歸**

Run: `pnpm --filter @caliber/web test`
Expected: PASS（含既有測試 + 本期 5 個新測試檔）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/dashboard/status/page.tsx apps/web/src/components/nav/Sidebar.tsx apps/web/tests/components/status/StatusPage.test.tsx
git commit -m "feat(web): /dashboard/status page shell + sidebar nav entry"
```

---

## 完成後

- [ ] 跑全測：`pnpm --filter @caliber/api test -- usage.test.ts && pnpm --filter @caliber/web test`
- [ ] 型別檢查：`pnpm --filter @caliber/web typecheck`（確認 `inferRouterOutputs` 取到新 `usage.errorSummary`）
- [ ] 進 `superpowers:finishing-a-development-branch`（已在 `feat/byok-status-dashboard` 分支）。

## 不變式回顧（對應 spec §7）

- **INV-S1**：① `listOwn` WHERE `userId=ctx.user.id`；②③ `scopeWhere(own)` = `userId=caller`。三區塊皆不回他人資料。
- **INV-S2**：② input 只收 `{type:"own"}`，型別層排除特權 scope；守門 = protectedProcedure + own-only + `ensureGatewayEnabled`。
- **INV-S3**：零 schema — 僅讀 `upstream_accounts` / `usage_logs`。
