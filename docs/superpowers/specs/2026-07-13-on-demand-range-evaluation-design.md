# On-demand range evaluation — design

**Date:** 2026-07-13
**Status:** Approved (pending spec review)

## Problem

The `caliber-agent` backfills up to 90 days of local Claude Code / Codex
telemetry on first enrollment (verified: member `steveonead` has `client_events`
from 2026-06-06, ~76k June events). But the nightly evaluator cron
(`apps/gateway/src/workers/evaluator/cron.ts`) only scores **yesterday** — it
never retroactively evaluates backfilled history. So a member's June telemetry
exists but has **no evaluation reports**, and selecting an April–June range in
the UI shows "此期間沒有評估報告" even though the raw data is present.

## Decision

Do **not** build a mass backfill / cron sweep. Instead, let an admin **generate
an evaluation on-demand for whatever range is selected** — which is already what
the existing `重跑此期間` (rerun) button does: it evaluates `[periodStart,
periodEnd]` (rule-based + LLM, gated by the existing coverage ≥ 0.5 rule) and
writes one report for that range. Two things block this today:

1. The `reports.rerun` backend caps a single evaluation window at **30 days**.
2. The **empty-state** card (range has no report yet) does **not** render the
   rerun button, so an empty range can't be evaluated at all — this is exactly
   the state a user hits when selecting a historical range.

## Scope

### 1. Backend — relax the rerun window cap

`apps/api/src/trpc/routers/reports.ts`, `rerun` mutation: replace the hard-coded
`WINDOW_LIMIT_MS = 30 * 24 * 60 * 60 * 1000` with a named constant
`MAX_RERUN_WINDOW_DAYS = 92` (one quarter — covers a calendar-quarter selection
like 04/01–06/30; bounded to avoid multi-year evaluations that would decrypt an
unbounded number of `request_bodies`). The mutation is otherwise unchanged: it
still enqueues **one** evaluator job for the window, `periodType: "daily"`, via
the existing deterministic `buildEvaluatorJobId` (so re-triggering dedups).

The `> 92 days` case still throws `BAD_REQUEST` ("Window exceeds 92 days").

### 2. Frontend — generate from any selected range

`apps/web/src/components/evaluator/`:

- **`EvaluationWindowSelect.ts`**:
  - Change `RERUN_MAX_DAYS` from `30` to `92` (kept in sync with the backend
    constant; a one-line comment cross-references it). This also re-enables the
    rerun button for the 90-day preset, which the 30-day guard had disabled.
  - Add a **`上季` (last quarter)** option — a new `{ mode: "quarter" }` selection
    that resolves to the most recent **completed** calendar quarter. `now` in
    Q3 → Q2 (04/01 00:00 → 06/30 23:59:59.999), computed at the viewer's local
    time (consistent with the custom picker). Q1 → previous year's Q4. A quarter
    is ≤ 92 days, so it is always within the rerun cap. Export
    `lastCompletedQuarter()` returning `{ year, quarter, from, to }`; render it
    as a fourth segmented button (order: `7天 · 30天 · 90天 · 上季 · 自訂`).
    Its date range is fixed (no date inputs shown, unlike custom).
- **`ReportDetail.tsx`**:
  - Add the rerun/generate button to the **empty-state** card (currently it only
    renders the window selector). Wrap it in `RequirePerm({type:"report.rerun",
    …})` and wire it to the same `handleRerun` + `rerunAllowed` guard as the
    populated header. This is the core fix — it lets a historical/empty range be
    evaluated.
  - The existing populated-state button is unchanged; with the new guard it now
    permits windows up to 92 days.

The button uses the currently-selected range (`rangeFrom`/`rangeTo`), which the
custom date picker and the `上季` preset already drive. `rerunAllowed =
rangeDays(from,to) <= 92 + ε`; the button is disabled with the `rerunMaxWindow`
hint beyond that.

Header/empty-state labels for the quarter mode show the quarter name (e.g.
`2026 Q2 · 最後更新 {date}`) via new i18n keys `windowQuarter` (button),
`windowUpdatedQuarter`, `windowHistoryQuarter` (+ `evaluator.profileEval.
windowUpdatedQuarter`) in all four catalogs; `{quarter}` is the computed
`"YYYY QN"` string.

### 3. Behaviour / UX notes (no code beyond the above)

- The generated report is keyed `period_start = range start` (existing rerun
  semantics). `getUser` returns it for any overlapping selected range, so the
  audience report then renders on the page.
- LLM deep-analysis runs only when window body-coverage ≥ 0.5 (existing gate in
  `runEvaluation.ts`); low-coverage historical ranges produce a rule-based
  score + section breakdown without an audience narrative.
- Enqueue is fire-and-forget: the toast confirms the job was queued; the report
  appears after the worker finishes (the eval upstream is slow, ~1–2 min) and
  the user reloads. Auto-refresh/polling is **out of scope** (pre-existing UX).

## Out of scope (YAGNI)

- Nightly self-healing backfill sweep; auto-evaluate-on-selection; per-day
  fan-out over a range; trend-chart daily backfill; a body-scan cap for very
  large windows (92-day bound makes it unnecessary for now); making the cap
  env-configurable (a named constant suffices).

## Testing

- **API** (`reports.rerun`): accepts a 90-day window (was rejected at 30);
  rejects a 93-day window; a valid long window enqueues exactly one job.
- **Web** (`ReportDetail`): the empty-state renders the generate button (behind
  `report.rerun` perm) and it is enabled for a ≤92-day range; the guard disables
  it beyond 92 days. `EvaluationWindowSelect`: `RERUN_MAX_DAYS === 92`;
  `lastCompletedQuarter()` returns the correct prior quarter (incl. the Q1 →
  previous-year-Q4 wrap) and a ≤92-day span; the `上季` button renders and, when
  active, drives the range without showing date inputs.

## Files touched

- `apps/api/src/trpc/routers/reports.ts` (cap constant + message)
- `apps/web/src/components/evaluator/EvaluationWindowSelect.tsx` (RERUN_MAX_DAYS,
  `quarter` mode, `lastCompletedQuarter()`, `上季` button)
- `apps/web/src/components/evaluator/ReportDetail.tsx` (empty-state button,
  quarter label)
- `apps/web/src/components/evaluator/ProfileEvaluation.tsx` (quarter label)
- `apps/web/messages/{en,zh-TW,zh-CN,ko}.json` (windowQuarter/UpdatedQuarter/
  HistoryQuarter + profileEval.windowUpdatedQuarter)
- Tests: `apps/api/tests/integration/trpc/reports.mutations.test.ts`,
  `apps/web/tests/components/evaluator/ReportDetail.test.tsx`,
  `apps/web/tests/components/evaluator/EvaluationWindowSelect.test.tsx`
