# On-demand Range Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin generate an evaluation report on-demand for any selected time range (up to one quarter), including a one-click "上季" (last-quarter) preset and a generate button on the empty state.

**Architecture:** No new backend flow — reuse the existing `reports.rerun` mutation, which already evaluates `[periodStart, periodEnd]` (rule-based + LLM, gated by coverage ≥ 0.5) and writes one report keyed by `period_start`. Two blockers are removed: the 30-day window cap (→ 92 days) and the missing generate button on the empty-state card. The window selector gains a `上季` preset (`{mode:"quarter"}`) resolving to the most recent completed calendar quarter.

**Tech Stack:** TypeScript, tRPC (`@caliber/api`), Next.js + React + next-intl (`@caliber/web`), Vitest, Tailwind.

## Global Constraints

- Single-eval window cap = **92 days** (one quarter). Backend constant `MAX_RERUN_WINDOW_DAYS = 92`; frontend `RERUN_MAX_DAYS = 92`; keep in sync (cross-reference in comments).
- i18n keys MUST be added to **all four** catalogs: `apps/web/messages/{en,zh-TW,zh-CN,ko}.json`. Message JSONs are stable under `JSON.stringify(obj, null, 2) + "\n"`.
- Do NOT use backtick template literals in thrown `TRPCError`/Zod `message:` strings (the `audit-zod-i18n` CI step flags them) — use a plain string.
- `git` push/merge/tag: run `gh auth switch --user hanfour && gh auth setup-git` first (the active account reverts each turn).
- Frontend date semantics: custom/quarter ranges resolve at the viewer's **local** time (consistent with the existing custom picker).
- Out of scope (do NOT build): nightly backfill sweep, auto-evaluate-on-selection, per-day fan-out, trend-chart daily backfill, auto-refresh/polling of the report after enqueue, env-configurable cap.

---

### Task 1: Relax the rerun window cap to 92 days (backend)

**Files:**
- Modify: `apps/api/src/trpc/routers/reports.ts:615-627` (the `rerun` mutation window check)
- Test: `apps/api/tests/integration/trpc/reports.mutations.test.ts` (append two tests near the existing rerun tests, ~line 326)

**Interfaces:**
- Produces: no new exports. Behavioural change only: `reports.rerun` accepts windows ≤ 92 days, rejects > 92 days with `BAD_REQUEST` message `"Window exceeds 92 days"`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("reports router — mutation endpoints", …)` in `apps/api/tests/integration/trpc/reports.mutations.test.ts` (mirror the queue-wired Test 2 pattern that uses `adminCaller` + a mock queue; reuse the same setup helpers already in the file):

```typescript
  // ── Window cap: 92 days (one quarter) ────────────────────────────────────────
  it("rerun accepts a 90-day window (within the 92-day cap)", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const adminCaller = makeCaller({
      user: adminUser,
      evaluatorQueue: { add } as unknown as EvaluatorQueue,
    });
    const result = await adminCaller.reports.rerun({
      orgId,
      scope: "user",
      targetId: memberUser.id,
      periodStart: "2025-04-01T00:00:00.000Z",
      periodEnd: "2025-06-30T00:00:00.000Z", // 90 days
    });
    expect(result.enqueued).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("rerun rejects a window longer than 92 days", async () => {
    const adminCaller = makeCaller({ user: adminUser });
    await expect(
      adminCaller.reports.rerun({
        orgId,
        scope: "user",
        targetId: memberUser.id,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-04-15T00:00:00.000Z", // 104 days
      }),
    ).rejects.toThrow(/Window exceeds 92 days/);
  });
```

Note: use whatever the file already names for the caller factory, admin user, member user, org id, and `EvaluatorQueue` type (read the top of the file and the existing Test 2 at ~line 288 to copy the exact identifiers — `makeCaller`, `adminUser`, `memberUser.id`, `orgId` are placeholders for the file's real names).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DOCKER_HOST=unix:///Users/hanfourhuang/.orbstack/run/docker.sock pnpm --filter @caliber/api exec vitest run --config vitest.integration.config.ts trpc/reports.mutations -t "92-day|92 days"`
Expected: FAIL — the 90-day case throws "Window exceeds 30 days" (current cap), the 104-day case throws "Window exceeds 30 days" not "92 days".

(If testcontainers can't run locally, rely on CI for this task's verification and note it.)

- [ ] **Step 3: Raise the cap**

In `apps/api/src/trpc/routers/reports.ts`, replace lines 615-627's window block. Current:

```typescript
      const WINDOW_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

      if (endMs <= startMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "periodEnd must be after periodStart",
        });
      }
      if (endMs - startMs > WINDOW_LIMIT_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Window exceeds 30 days",
        });
      }
```

Replace with:

```typescript
      // One quarter — the evaluator reads/decrypts every request_body in the
      // window, so this bounds a single on-demand evaluation. Keep in sync with
      // the web RERUN_MAX_DAYS in EvaluationWindowSelect.tsx.
      const MAX_RERUN_WINDOW_DAYS = 92;
      const WINDOW_LIMIT_MS = MAX_RERUN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

      if (endMs <= startMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "periodEnd must be after periodStart",
        });
      }
      if (endMs - startMs > WINDOW_LIMIT_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Window exceeds 92 days",
        });
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DOCKER_HOST=unix:///Users/hanfourhuang/.orbstack/run/docker.sock pnpm --filter @caliber/api exec vitest run --config vitest.integration.config.ts trpc/reports.mutations -t "92-day|92 days"`
Expected: PASS (both).

Also run typecheck: `pnpm --filter @caliber/api typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/reports.ts apps/api/tests/integration/trpc/reports.mutations.test.ts
git commit -m "feat(api): raise reports.rerun window cap 30→92 days (one quarter)"
```

---

### Task 2: Window selector — 92-day guard + 上季 (last-quarter) preset

**Files:**
- Modify: `apps/web/src/components/evaluator/EvaluationWindowSelect.tsx`
- Modify: `apps/web/messages/{en,zh-TW,zh-CN,ko}.json` (add `evaluator.report.windowQuarter`)
- Test: `apps/web/tests/components/evaluator/EvaluationWindowSelect.test.tsx`

**Interfaces:**
- Produces:
  - `RERUN_MAX_DAYS = 92` (was 30)
  - `WindowSelection` gains `| { mode: "quarter" }`
  - `export interface Quarter { year: number; quarter: number; from: string; to: string }`
  - `export function lastCompletedQuarter(): Quarter`
  - `selectionToRange(sel)` handles `mode: "quarter"`
  - The component renders a `上季` button (order: 7天 · 30天 · 90天 · 上季 · 自訂)

- [ ] **Step 1: Write the failing tests**

Replace the `defaults to the 30-day preset` assertion and add quarter tests in `EvaluationWindowSelect.test.tsx`. Add these to the `describe("range helpers", …)` block:

```typescript
  it("RERUN_MAX_DAYS is one quarter (92 days)", () => {
    expect(RERUN_MAX_DAYS).toBe(92);
  });

  it("lastCompletedQuarter returns a prior, ≤92-day quarter", () => {
    const q = lastCompletedQuarter();
    expect(q.quarter).toBeGreaterThanOrEqual(1);
    expect(q.quarter).toBeLessThanOrEqual(4);
    const span = rangeDays(q.from, q.to);
    expect(span).toBeGreaterThan(89);
    expect(span).toBeLessThanOrEqual(92);
    // The quarter is fully in the past.
    expect(new Date(q.to).getTime()).toBeLessThan(Date.now());
  });

  it("selectionToRange resolves the quarter mode to the last quarter", () => {
    const q = lastCompletedQuarter();
    const r = selectionToRange({ mode: "quarter" });
    expect(r.from).toBe(q.from);
    expect(r.to).toBe(q.to);
  });
```

Add the import of `lastCompletedQuarter` to the test's import block. In the component `describe`, add:

```typescript
  it("renders a 上季 button that emits the quarter selection", async () => {
    const onChange = vi.fn<(s: WindowSelection) => void>();
    render(
      <EvaluationWindowSelect value={{ mode: "preset", days: 30 }} onChange={onChange} />,
    );
    // Presets (3) + 上季 + 自訂 = 5 buttons.
    expect(screen.getAllByRole("button")).toHaveLength(5);
    const quarter = screen.getByText("上季");
    await userEvent.click(quarter);
    expect(onChange).toHaveBeenCalledWith({ mode: "quarter" });
  });
```

Update the existing `renders a button per preset plus Custom` test's expected count from `WINDOW_PRESETS.length + 1` to `WINDOW_PRESETS.length + 2` (presets + 上季 + 自訂).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/evaluator/EvaluationWindowSelect.test.tsx`
Expected: FAIL — `RERUN_MAX_DAYS` is 30, `lastCompletedQuarter`/quarter mode undefined, no 上季 button.

- [ ] **Step 3: Implement the quarter mode + button**

In `EvaluationWindowSelect.tsx`:

Change line 9-10:

```typescript
/** The rerun backend caps a single re-evaluation window at 92 days (one quarter).
 * Keep in sync with MAX_RERUN_WINDOW_DAYS in apps/api/.../reports.ts. */
export const RERUN_MAX_DAYS = 92;
```

Change the `WindowSelection` type (line 18-20) to add the quarter variant:

```typescript
export type WindowSelection =
  | { mode: "preset"; days: WindowDays }
  | { mode: "quarter" }
  | { mode: "custom"; fromDate: string; toDate: string };
```

Add after `defaultCustomSelection` (line 40):

```typescript
export interface Quarter {
  year: number;
  quarter: number; // 1-4
  from: string;
  to: string;
}

/** The most recent COMPLETED calendar quarter (local time). now in Q3 → Q2;
 * now in Q1 → previous year's Q4. Always a fully-past, ≤92-day span. */
export function lastCompletedQuarter(): Quarter {
  const now = new Date();
  let year = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) - 1; // 0-3
  if (q < 0) {
    q = 3;
    year -= 1;
  }
  const startMonth = q * 3;
  const from = new Date(year, startMonth, 1, 0, 0, 0, 0);
  const to = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  return { year, quarter: q + 1, from: from.toISOString(), to: to.toISOString() };
}
```

In `selectionToRange` (line 47-60), add the quarter branch before the custom branch:

```typescript
export function selectionToRange(sel: WindowSelection): {
  from: string;
  to: string;
} {
  if (sel.mode === "quarter") {
    const q = lastCompletedQuarter();
    return { from: q.from, to: q.to };
  }
  if (sel.mode === "custom") {
    const fromMs = Date.parse(`${sel.fromDate}T00:00:00`);
    const toMs = Date.parse(`${sel.toDate}T23:59:59.999`);
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && fromMs <= toMs) {
      return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    }
    return windowRange(30);
  }
  return windowRange(sel.days);
}
```

In the component (after line 76 `const isCustom = …`), add:

```typescript
  const isQuarter = value.mode === "quarter";
```

Insert the 上季 button in the segmented control, between the presets `.map(...)` closing `))}` (line 99) and the `自訂` button (line 100):

```tsx
        <button
          type="button"
          aria-pressed={isQuarter}
          onClick={() => onChange({ mode: "quarter" })}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            isQuarter
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("windowQuarter")}
        </button>
```

- [ ] **Step 4: Add the `windowQuarter` i18n key to all 4 catalogs**

Run this script (adds `evaluator.report.windowQuarter`):

```bash
node -e '
const fs=require("fs");
const V={en:"Last quarter","zh-TW":"上季","zh-CN":"上季度",ko:"지난 분기"};
for(const [lang,val] of Object.entries(V)){
 const p=`./apps/web/messages/${lang}.json`; const m=JSON.parse(fs.readFileSync(p,"utf8"));
 m.evaluator.report.windowQuarter=val;
 fs.writeFileSync(p, JSON.stringify(m,null,2)+"\n");
}
console.log("windowQuarter added");
'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/evaluator/EvaluationWindowSelect.test.tsx tests/lib/i18n/messagesParity.test.ts`
Expected: PASS. Also `pnpm --filter @caliber/web typecheck` → no errors (the `WindowSelection` union change may surface exhaustiveness gaps in consumers — those are fixed in Tasks 3-4; if typecheck fails ONLY in ReportDetail/ProfileEvaluation, that is expected and resolved there).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/evaluator/EvaluationWindowSelect.tsx apps/web/tests/components/evaluator/EvaluationWindowSelect.test.tsx apps/web/messages
git commit -m "feat(web): 上季 (last-quarter) preset + 92-day rerun guard in the window selector"
```

---

### Task 3: ReportDetail — generate button on empty state + quarter labels

**Files:**
- Modify: `apps/web/src/components/evaluator/ReportDetail.tsx`
- Modify: `apps/web/messages/{en,zh-TW,zh-CN,ko}.json` (add `windowUpdatedQuarter`, `windowHistoryQuarter`, `generateBtn`)
- Test: `apps/web/tests/components/evaluator/ReportDetail.test.tsx`

**Interfaces:**
- Consumes from Task 2: `WindowSelection` (incl. `mode:"quarter"`), `lastCompletedQuarter`, `RERUN_MAX_DAYS`, `selectionToRange`, `rangeDays`.

- [ ] **Step 1: Write the failing test**

In `ReportDetail.test.tsx`, add a test where `getUser` returns an empty array and assert the generate button renders. Use the file's existing mock setup (it mocks `trpc.reports.getUser.useQuery`). Add:

```typescript
  it("shows a generate button on the empty state (report.rerun perm)", () => {
    getUser.mockReturnValue({ data: [], isLoading: false, error: null });
    rubricGet.mockReturnValue({ data: null });
    render(<ReportDetail orgId="org-1" userId="u-1" userName="Steve" />);
    expect(
      screen.getByText(/Generate report for this range|產生此區間報告/i),
    ).toBeInTheDocument();
  });
```

(`getUser`/`rubricGet` are the file's existing mock handles — see its top. `RequirePerm` is already mocked to render children in this test file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/evaluator/ReportDetail.test.tsx -t "generate button"`
Expected: FAIL — no generate button in the empty state (and `generateBtn` key missing).

- [ ] **Step 3: Refactor the window label to handle quarter mode**

In `ReportDetail.tsx`, replace lines 54-55:

```typescript
  const windowLabelKey = sel.mode === "custom" ? "windowUpdatedCustom" : "windowUpdated";
  const windowLabelDays = sel.mode === "preset" ? sel.days : 0;
```

with:

```typescript
  const quarterName = (() => {
    const q = lastCompletedQuarter();
    return `${q.year} Q${q.quarter}`;
  })();
  const windowLabelKey =
    sel.mode === "custom"
      ? "windowUpdatedCustom"
      : sel.mode === "quarter"
        ? "windowUpdatedQuarter"
        : "windowUpdated";
  const windowLabelValues: Record<string, string | number> =
    sel.mode === "preset" ? { days: sel.days } : sel.mode === "quarter" ? { quarter: quarterName } : {};
```

Add `lastCompletedQuarter` to the import from `./EvaluationWindowSelect` at the top of the file (it currently imports `EvaluationWindowSelect, selectionToRange, rangeDays, RERUN_MAX_DAYS, DEFAULT_SELECTION, type WindowSelection`).

Update the populated-header description usage (the `t(windowLabelKey, { days: windowLabelDays, date: … })` call around line 148) to spread the values:

```tsx
            <CardDescription>
              {t(windowLabelKey, {
                ...windowLabelValues,
                date: new Date(latest.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
```

- [ ] **Step 4: Add the generate button + quarter description to the empty state**

Replace the empty-state block (lines 112-131) with:

```tsx
  if (!reports || reports.length === 0) {
    const emptyDesc =
      sel.mode === "custom"
        ? t("windowHistoryCustom")
        : sel.mode === "quarter"
          ? t("windowHistoryQuarter", { quarter: quarterName })
          : t("windowHistory", { days: sel.days });
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("evaluationTitle")}</CardTitle>
            <CardDescription>{emptyDesc}</CardDescription>
          </div>
          <EvaluationWindowSelect value={sel} onChange={setSel} />
        </CardHeader>
        <CardContent className="space-y-3 py-6 text-center text-sm text-muted-foreground">
          <p>{t("noReports")}</p>
          <RequirePerm
            action={{ type: "report.rerun", orgId, targetUserId: userId, periodStart: rangeFrom }}
          >
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleRerun}
              disabled={rerunMutation.isPending || !rerunAllowed}
              title={!rerunAllowed ? t("rerunMaxWindow", { days: RERUN_MAX_DAYS }) : undefined}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {rerunMutation.isPending ? t("queueing") : t("generateBtn")}
            </Button>
          </RequirePerm>
        </CardContent>
      </Card>
    );
  }
```

(`Button`, `RotateCcw`, `RequirePerm` are already imported in this file.)

- [ ] **Step 5: Add the 3 i18n keys to all 4 catalogs**

```bash
node -e '
const fs=require("fs");
const V={
 en:{windowUpdatedQuarter:"{quarter} · last updated {date}",windowHistoryQuarter:"{quarter} score history",generateBtn:"Generate report for this range"},
 "zh-TW":{windowUpdatedQuarter:"{quarter} · 最後更新 {date}",windowHistoryQuarter:"{quarter} 分數歷史",generateBtn:"產生此區間報告"},
 "zh-CN":{windowUpdatedQuarter:"{quarter} · 最后更新 {date}",windowHistoryQuarter:"{quarter} 分数历史",generateBtn:"生成此区间报告"},
 ko:{windowUpdatedQuarter:"{quarter} · 마지막 업데이트 {date}",windowHistoryQuarter:"{quarter} 점수 기록",generateBtn:"이 기간의 보고서 생성"},
};
for(const [lang,ns] of Object.entries(V)){
 const p=`./apps/web/messages/${lang}.json`; const m=JSON.parse(fs.readFileSync(p,"utf8"));
 Object.assign(m.evaluator.report, ns);
 fs.writeFileSync(p, JSON.stringify(m,null,2)+"\n");
}
console.log("report quarter/generate keys added");
'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/evaluator/ReportDetail.test.tsx tests/lib/i18n/messagesParity.test.ts && pnpm --filter @caliber/web typecheck`
Expected: PASS + no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/evaluator/ReportDetail.tsx apps/web/tests/components/evaluator/ReportDetail.test.tsx apps/web/messages
git commit -m "feat(web): generate-for-range button on empty evaluation state + quarter labels"
```

---

### Task 4: ProfileEvaluation — quarter label

**Files:**
- Modify: `apps/web/src/components/evaluator/ProfileEvaluation.tsx`
- Modify: `apps/web/messages/{en,zh-TW,zh-CN,ko}.json` (add `evaluator.profileEval.windowUpdatedQuarter`)
- Test: `apps/web/tests/components/evaluator/ProfileEvaluation.test.tsx` (existing test must still pass; i18n parity is the gate)

**Interfaces:**
- Consumes from Task 2: `WindowSelection` (incl. `mode:"quarter"`), `lastCompletedQuarter`.

- [ ] **Step 1: Add the profileEval quarter key to all 4 catalogs**

```bash
node -e '
const fs=require("fs");
const V={en:"{quarter} · period ending {date}","zh-TW":"{quarter} · 期間結束於 {date}","zh-CN":"{quarter} · 期间结束于 {date}",ko:"{quarter} · 기간 종료 {date}"};
for(const [lang,val] of Object.entries(V)){
 const p=`./apps/web/messages/${lang}.json`; const m=JSON.parse(fs.readFileSync(p,"utf8"));
 m.evaluator.profileEval.windowUpdatedQuarter=val;
 fs.writeFileSync(p, JSON.stringify(m,null,2)+"\n");
}
console.log("profileEval quarter key added");
'
```

- [ ] **Step 2: Handle quarter mode in the header label**

In `ProfileEvaluation.tsx`, add `lastCompletedQuarter` to the import from `./EvaluationWindowSelect` (currently imports `EvaluationWindowSelect, selectionToRange, DEFAULT_SELECTION, type WindowSelection`).

Replace the header `CardDescription` block (the `t(sel.mode === "custom" ? "windowUpdatedCustom" : "windowUpdated", { days: sel.mode === "preset" ? sel.days : 0, date: … })` call) with:

```tsx
            <CardDescription>
              {(() => {
                const quarterName = (() => {
                  const q = lastCompletedQuarter();
                  return `${q.year} Q${q.quarter}`;
                })();
                const key =
                  sel.mode === "custom"
                    ? "windowUpdatedCustom"
                    : sel.mode === "quarter"
                      ? "windowUpdatedQuarter"
                      : "windowUpdated";
                const values: Record<string, string | number> =
                  sel.mode === "preset"
                    ? { days: sel.days }
                    : sel.mode === "quarter"
                      ? { quarter: quarterName }
                      : {};
                return t(key, {
                  ...values,
                  date: new Date(latestReport.periodStart).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  }),
                });
              })()}
            </CardDescription>
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/evaluator/ProfileEvaluation.test.tsx tests/lib/i18n/messagesParity.test.ts && pnpm --filter @caliber/web typecheck`
Expected: PASS + no type errors (the `WindowSelection` union is now exhaustively handled everywhere).

- [ ] **Step 4: Full gate**

Run: `pnpm turbo run typecheck lint`
Expected: all tasks succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/ProfileEvaluation.tsx apps/web/messages
git commit -m "feat(web): quarter-mode label on the profile evaluation view"
```

---

## Self-Review

- **Spec coverage:** cap→92 (Task 1) ✓; empty-state generate button (Task 3) ✓; 90-preset re-enable via RERUN_MAX_DAYS=92 (Task 2) ✓; 上季 preset + lastCompletedQuarter (Task 2) ✓; quarter labels in ReportDetail + ProfileEvaluation (Tasks 3-4) ✓; i18n ×4 (Tasks 2-4) ✓; button order 7·30·90·上季·自訂 (Task 2) ✓.
- **Type consistency:** `lastCompletedQuarter()` / `Quarter` / `RERUN_MAX_DAYS` / `WindowSelection.mode:"quarter"` defined in Task 2, consumed in Tasks 3-4. `MAX_RERUN_WINDOW_DAYS` (api) and `RERUN_MAX_DAYS` (web) both 92.
- **Placeholders:** identifiers `makeCaller`/`adminUser`/`memberUser`/`orgId`/`EvaluatorQueue` in Task 1 are explicitly flagged as "read the file for the real names" — the tester copies the existing Test 2 pattern.
