# GitHub Delivery PR 4 — UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the delivery-scoring UI (spec Component 5): a 「交付產出」 tab on member detail, a delivery-score column on the team leaderboard, and a GitHub-connection settings page — consuming the already-merged `githubDelivery` router. Last piece before flag-flip + live smoke.

**Architecture:** Pure `apps/web` work + i18n. `DeliveryDetail` mirrors `ReportDetail`'s self-contained shape (own window state, reuses `EvaluationWindowSelect` + `reportDetailShared` exports). Leaderboard column uses the `MemberScoreCell` per-cell-query pattern (no new API). Settings page slots into the `evaluator/` sub-nav TABS with `github.manage` gating, form idioms from `UpstreamRegisterDialog`/`SettingsForm`. Flag-off UX = the repo's query-failure convention (NOT_FOUND → quiet fallback), no client-side env gate.

**Tech Stack:** Next.js App Router, `trpc` react client, next-intl (**5 catalogs: en, zh-TW, zh-CN, ja, ko** — spec said 4; ja exists), RTL+vitest+jsdom, sonner, react-hook-form + `useTranslatedZodResolver`.

## Global Constraints

- **Never sum the two scores.** Delivery score renders with the same visual language (`scoreBadgeClass`, `.toFixed(1)`, insufficient-data pill) but is always a separate figure.
- **Memoized ranges are MANDATORY** — every date range fed to a query key goes through `useMemo` (`selectionToRange` / fixed-window pattern; see the churn-warning comments in ReportDetail.tsx:48-51, MemberScoreCell.tsx:25-29). A bare `new Date()` in render = infinite refetch = review reject.
- `totalScore`/`llmQualityAdjustment` arrive as **decimal strings** (or null) — `parseFloat` before `.toFixed(1)`; never render NaN (test-pinned).
- RBAC gates (all exist already): delivery tab + content `{type:"delivery.read_user", orgId, targetUserId}`; generate button + settings page `{type:"github.manage", orgId}` — via `<RequirePerm action={...}>` (its `action` prop IS the `@caliber/auth` Action union).
- Flag-off / feature-absent: NOT_FOUND from `githubProcedure` renders a muted "not enabled" card (precedent: `AccountGroupDetail.tsx:73` isNotFound handling) — never a raw error dump; the PAT/token is never rendered anywhere (only `tokenLast4`).
- **Every task that adds i18n keys adds them to ALL FIVE catalogs in the same commit** (the parity test fails otherwise) AND extends `apps/web/tests/lib/i18n/messagesParity.test.ts` with the new key paths. en.json is source-of-truth; zh-TW must be natural 台灣用語; zh-CN/ja/ko best-effort (native review rides the existing #134 debt).
- Component tests follow the `ReportDetail.test.tsx` harness verbatim: `vi.mock("@/lib/trpc/client")` nested-hook object, `RequirePerm` passthrough stub, `sonner` stub, next-intl auto-stubbed to real en.json by `tests/setup.ts`.
- Commit format: `<type>(<scope>): <description>` — NO Co-Authored-By trailer. Branch `feat/github-delivery-pr4-ui` (exists, from `113e20a`).
- **Documented spec deviation:** the leaderboard delivery column is display-only (not click-sortable) in v1 — the codebase has zero click-to-sort interaction precedent and delivery data is fetched per-cell; existing sort behavior (leaderboardEnabled → AI-score desc) is untouched. Record in the PR body.

---

### Task 1: `DeliveryDetail` core (score card, sections, states, window, generate)

**Files:**
- Create: `apps/web/src/components/delivery/DeliveryDetail.tsx`
- Test: `apps/web/tests/components/delivery/DeliveryDetail.test.tsx`
- Modify: `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` (namespace `evaluator.delivery.*`), `apps/web/tests/lib/i18n/messagesParity.test.ts` (new `DELIVERY_KEYS` array + describe)

**Component contract:**
- `DeliveryDetail({ orgId, userId, userName }: { orgId: string; userId: string; userName?: string | null })` — self-contained sibling of `ReportDetail` (model its file top-to-bottom; reuse `WindowSelection`/`DEFAULT_SELECTION`/`selectionToRange`/`EvaluationWindowSelect` and `scoreBadgeClass`/insufficient-pill idioms from `reportDetailShared.tsx`).
- Data: `trpc.githubDelivery.getReport.useQuery({ orgId, userId, from: rangeFrom, to: rangeTo })` (memoized range).
- States (each a test):
  1. loading → standard loading card.
  2. NOT_FOUND error (flag off) → muted card `t("notEnabled")` — check `(error.data as {code?:string})?.code === "NOT_FOUND"`; other errors → standard error card with `error.message`.
  3. `data === null` (no report yet) → empty-state card: `t("noReport")` + window selector + generate button (admin).
  4. `metrics.noIdentity` truthy → `t("noIdentity")` explainer card (member has no linked GitHub account).
  5. report with `insufficientData: true` → insufficient pill in the header chip position, sections still rendered.
  6. full report → header (score chip via `scoreBadgeClass(parseFloat(totalScore))` + `t("scoreLabel")`), **LLM adjustment badge** when `llmStatus === "ok"` and `llmQualityAdjustment != null`: signed value (`+8.0` / `-3.5`, `parseFloat` + explicit `+` prefix for ≥0) with tooltip-ish suffix `t("adjustmentLabel")`; `llmStatus === "parse_error" | "budget_denied"` → small zinc note `t("llmSkipped")` (single shared key with `{reason}` interpolation is fine).
  7. sections table: `sectionScores` is the `DeliverySectionScore[]` from the API (`key/weight/score/metrics[{key,value,scaledCurve,subscore}]`) — one row per section: name via `t(\`section.${key}\`)`. **LOCK: section scores display as percent** — `score === null ? insufficient pill : \`${Math.round(score * 100)}%\`` (the 0-1 fraction; do NOT multiply by 120 or by weight). Under each section, an always-expanded metric list: metric name `t(\`metric.${key}\`)`, raw `value ?? "—"` (medians `.toFixed(1)`, counts as-is), subscore as percent (`subscore === null ? "—" : \`${Math.round(subscore * 100)}%\``).
- Generate button: `<RequirePerm action={{type:"github.manage", orgId}}>` → button `t("generateBtn")`; `trpc.githubDelivery.generate.useMutation` with payload `{orgId, userId, from: rangeFrom, to: rangeTo}`; onSuccess → `toast.success(t("generateQueued"))` + `utils.githubDelivery.getReport.invalidate()`; onError FORBIDDEN → `tCommon("insufficientPermission")` toast, else `e.message`; disable while `isPending`. Present in BOTH empty state and header (ReportDetail's dual-placement precedent).
- Metrics summary line: `t("windowMeta", {days: metrics.windowDays, events: metrics.totalEvents})` under the header when report present.

**i18n keys (en values locked; translate ×5):** `evaluator.delivery.title` "Delivery" / zh-TW 「交付產出」; `loading`; `notEnabled` "GitHub delivery scoring is not enabled for this workspace."; `noReport` "No delivery report for this window yet."; `noIdentity` "This member has no linked GitHub account, so delivery activity can't be attributed."; `scoreLabel` "Delivery score"; `adjustmentLabel` "LLM quality adjustment"; `llmSkipped` "Quality review unavailable ({reason})"; `generateBtn` "Generate delivery report"; `generateQueued` "Delivery report queued — refresh shortly."; `windowMeta` "{days}-day window · {events} delivery events"; `section.throughput` "Throughput"; `section.collaboration` "Collaboration"; `section.timeliness` "Timeliness"; `metric.merged_pr_count` "Merged PRs"; `metric.issues_closed_count` "Issues closed"; `metric.project_items_completed` "Project items completed"; `metric.reviews_submitted` "Reviews submitted"; `metric.distinct_prs_reviewed` "Distinct PRs reviewed"; `metric.pr_lead_time_hours_median` "Median PR lead time (h)"; `metric.issue_resolution_days_median` "Median issue resolution (d)"; `insufficientData` reuse `evaluator.report.insufficientData` (do NOT duplicate).

**Tests (harness per Global Constraints; fixture `totalScore: "88.5"`, adjustment `"8.00"` strings):** loading; NOT_FOUND→notEnabled text; null→noReport + generate visible; noIdentity card; insufficient pill + no NaN anywhere (`expect(screen.queryByText(/NaN/)).toBeNull()`); full render (88.5 shown, "+8.0" badge, three section names, a metric row); generate click → mutation called with the memoized range + queued toast.

- [ ] TDD: tests RED → implement → GREEN (`cd apps/web && npm test -- DeliveryDetail`); parity test extended + green (`npm test -- messagesParity`); `pnpm --filter @caliber/web typecheck` (or the package's lint script) exit 0.
- [ ] Commit: `feat(web): DeliveryDetail — delivery score card, sections, LLM badge, generate`

---

### Task 2: Activity list + LLM narrative/evidence blocks (into `DeliveryDetail`)

**Files:**
- Create: `apps/web/src/components/delivery/DeliveryActivityList.tsx`, `apps/web/src/components/delivery/DeliveryNarrative.tsx`
- Modify: `apps/web/src/components/delivery/DeliveryDetail.tsx` (compose both under the sections table)
- Test: `apps/web/tests/components/delivery/DeliveryActivityList.test.tsx`, `DeliveryNarrative.test.tsx`
- Modify: 5 catalogs + parity arrays

**Contracts:**
- `DeliveryNarrative({ report })` — renders ONLY when `llmStatus === "ok"`: `t("narrativeTitle")` heading + narrative paragraph + evidence list (each item: `{repo}#{prNumber}` link `https://github.com/{repo}/pull/{prNumber}` (target _blank, rel noreferrer), blockquote `quote`, muted `reason`). Evidence array defensively: non-array/empty → omit the list. Keys: `narrativeTitle` "Quality review"; `evidenceTitle` "Evidence".
- `DeliveryActivityList({ orgId, userId, from, to })` — `trpc.githubDelivery.listActivity.useQuery({orgId, userId, from, to})` (range props are the parent's memoized values). Renders three compact lists (PRs / Issues / Reviews) with counts in headings; each PR/issue row: title (external link via `htmlUrl`, ExternalLink icon per repo convention if one exists — mirror how other components render external links), repo#number, date (`mergedAt`/`closedAt`/`submittedAt` → `new Date(x).toLocaleDateString()`). Reviews rows: `repo#number · state`. `ghUserId === null` → single muted line `t("noLinkedAccount")`; all three empty → `t("noActivity")`. Loading → skeleton line; error → error card (NOT_FOUND → nothing, parent already shows notEnabled).
- Keys: `activityTitle` "Recent activity"; `pulls` "Pull requests"; `issues` "Issues"; `reviews` "Reviews"; `noActivity` "No delivery activity in this window."; `noLinkedAccount` "No linked GitHub account."

**Tests:** narrative renders quote+link href correctly and is absent for `llmStatus: "parse_error"`; malformed evidence (string item) doesn't crash (parent passes as-is — component filters non-object items); activity happy render (3 sections + hrefs), null ghUserId line, empty state.

- [ ] TDD RED→GREEN; parity green; typecheck exit 0.
- [ ] Commit: `feat(web): delivery activity list + LLM narrative/evidence blocks`

---

### Task 3: Member-detail tab strip wiring

**Files:**
- Modify: `apps/web/src/app/dashboard/organizations/[id]/members/[uid]/page.tsx` (`MemberDetailBody` gains an in-page tab toggle)
- Test: `apps/web/tests/components/delivery/memberDetailTabs.test.tsx` (or extend the page's existing test file if one exists — check first)
- Modify: 5 catalogs + parity (`evaluator.delivery.tabEvaluation` "Evaluation" / `tabDelivery` "Delivery" — reuse `title` if identical is cleaner; LOCK: add `tabEvaluation`, reuse `evaluator.delivery.title` for the delivery tab label)

**Contract:** in `MemberDetailBody`, below the member header: a hand-rolled `border-b` tab strip (idiom: `organizations/[id]/layout.tsx:144-170`, but `useState`-toggled buttons, not Links — no sub-routes). Tab 1 `t("tabEvaluation")` → existing `<ReportDetail …/>`. Tab 2 (delivery title) → `<DeliveryDetail …/>`, the TAB BUTTON itself wrapped in `<RequirePerm action={{type:"delivery.read_user", orgId, targetUserId: uid}}>` (self sees own; org_admin sees all; others never see the tab). Default tab = evaluation. State-only, no URL param (v1).

**Tests:** default shows ReportDetail content (mock both children lightly — or mock the two components with `vi.mock` returning marker divs and assert toggle behavior + RequirePerm-gated tab presence).

- [ ] TDD RED→GREEN; parity; typecheck.
- [ ] Commit: `feat(web): member detail delivery tab (delivery.read_user gated)`

---

### Task 4: Leaderboard delivery column

**Files:**
- Create: `apps/web/src/components/delivery/DeliveryScoreCell.tsx`
- Modify: `apps/web/src/components/evaluator/TeamLeaderboard.tsx` (new column)
- Test: `apps/web/tests/components/delivery/DeliveryScoreCell.test.tsx` + extend the TeamLeaderboard test
- Modify: 5 catalogs + parity (`evaluator.leaderboard.deliveryScore` "Delivery")

**Contract:**
- `DeliveryScoreCell({ orgId, userId })` — mirror `MemberScoreCell.tsx` wholesale: `<RequirePerm action={{type:"delivery.read_user", orgId, targetUserId: userId}} fallback={<span className="text-xs text-muted-foreground">—</span>}>`, memoized fixed 30-day range, `trpc.githubDelivery.getReport.useQuery`, renders: loading "…" muted; error (incl. NOT_FOUND) or null data → "—"; insufficientData → the exact insufficient pill; else `parseFloat(totalScore).toFixed(1)` with `scoreColorClass` + tabular-nums.
- TeamLeaderboard: `<th>{tLb("deliveryScore")}</th>` between Score and Trend; each row `<td className="px-3 py-2 text-right"><DeliveryScoreCell orgId={orgId} userId={row.userId}/></td>` (match the existing cell paddings/alignment exactly). Sort logic UNTOUCHED (documented deviation). No change to `MemberRow` or the report fetching.

**Tests:** cell states (loading/—/pill/score-colored value, no NaN); leaderboard renders the new header + one cell per row (mock DeliveryScoreCell with a marker in the leaderboard test to avoid nested trpc plumbing).

- [ ] TDD RED→GREEN; parity; typecheck.
- [ ] Commit: `feat(web): team leaderboard delivery-score column (display-only v1)`

---

### Task 5: GitHub connection settings page

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/evaluator/github/page.tsx` (thin: `use(params)` → resolve → `<RequirePerm action={{type:"github.manage", orgId}} fallback={access-card}>` → `<GithubConnectionSettings orgId/>` — mirror `evaluator/settings/page.tsx` exactly)
- Create: `apps/web/src/components/delivery/GithubConnectionSettings.tsx`
- Modify: `apps/web/src/app/dashboard/organizations/[id]/evaluator/layout.tsx` (TABS array gains `{href: "github", label from i18n, action: (orgId) => ({type:"github.manage", orgId})}` — follow the array's exact entry shape)
- Test: `apps/web/tests/components/delivery/GithubConnectionSettings.test.tsx`
- Modify: 5 catalogs + parity (namespace `evaluator.githubConnection.*`)

**Contract (`GithubConnectionSettings({orgId})`):**
- Status card: `trpc.githubDelivery.getConnection.useQuery({orgId})` → when a connection exists show: owner (`ownerLogin`), token masked `••••{tokenLast4}`, status badge (ok=emerald / auth_error=red / rate_limited=amber / sync_error=amber — small pills), `lastSyncAt` localized or `t("neverSynced")`, `lastSyncError` (muted, truncated by CSS), repo allowlist (chips or comma line; null → `t("allRepos")`). NOT_FOUND (flag off) → `t("notEnabled")` muted card. No connection (null) → `t("noConnection")` + the form below.
- Actions row: `t("syncNowBtn")` → `githubDelivery.syncNow` mutation (toast success `t("syncQueued")`, invalidate getConnection); `t("deleteBtn")` (destructive style) → `window.confirm(t("deleteConfirm"))` → `deleteConnection` (toast + invalidate). Buttons disabled while pending.
- Connect/replace form (react-hook-form + `useTranslatedZodResolver`, model `UpstreamRegisterDialog.tsx`): fields `ownerLogin` (text input, placeholder "acme"), `token` (**textarea `autoComplete="off"`**, placeholder "github_pat_…", NEVER echoed back — clear the field on success), `repoAllowlist` (optional textarea, one `owner/repo` per line → split/trim/filter to array; empty → undefined). Zod: `ownerLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)`, `token: z.string().min(20).max(255)`, `repoAllowlist: z.string().optional()`. Submit → `setConnection.mutateAsync({orgId, ownerLogin, token, repoAllowlist: parsedOrUndefined})`; onSuccess → `toast.success(t("connectedToast", {repo: sampleRepo ?? ownerLogin}))`, reset form, invalidate getConnection; onError BAD_REQUEST → `toast.error(t("probeFailed"))` + message, FORBIDDEN → insufficientPermission, else message.
- Keys (en locked): `title` "GitHub connection"; `tabLabel` "GitHub"; `notEnabled` (reuse delivery.notEnabled? separate namespace — add its own `notEnabled` for independence); `noConnection` "No GitHub connection yet — add a fine-grained PAT to start syncing delivery activity."; `owner` "Owner"; `tokenLabel` "Fine-grained PAT"; `tokenHint` "Needs read-only Issues, Pull requests, Projects and metadata permissions. Stored encrypted; never shown again."; `allowlistLabel` "Repo allowlist (optional, one owner/repo per line)"; `allRepos` "All repos visible to the token"; `statusLabel` "Status"; `status.ok` "OK"; `status.auth_error` "Auth error — token revoked or missing permissions"; `status.rate_limited` "Rate limited"; `status.sync_error` "Sync errors"; `lastSync` "Last sync"; `neverSynced` "Never"; `lastError` "Last error"; `connectBtn` "Save connection"; `connectedToast` "Connected — probe saw {repo}."; `probeFailed` "GitHub rejected the connection"; `syncNowBtn` "Sync now"; `syncQueued` "Sync queued."; `deleteBtn` "Remove connection"; `deleteConfirm` "Remove the GitHub connection? Synced activity data stays."

**Tests:** no-connection → form visible; connected → masked token (assert "••••" + last4 present, full token string ABSENT from DOM given a fixture), status pill text, syncNow click → mutation + toast; submit path → setConnection called with parsed allowlist array + token field cleared after success; NOT_FOUND → notEnabled.

- [ ] TDD RED→GREEN; parity; typecheck.
- [ ] Commit: `feat(web): GitHub connection settings page (github.manage gated)`

---

### Task 6: Full verification + PR

- [ ] `pnpm turbo run lint typecheck test` (42 tasks) — web unit suite included; `pnpm --filter @caliber/gateway test:integration` + `pnpm --filter @caliber/api test:integration` (regression only — no server code changed this PR; if untouched-suite flakes appear under load, re-run the affected file in isolation per the PR3 protocol).
- [ ] Grep-audit: no component ever renders a raw `token` value; every new date range memoized (`grep -n "new Date()" apps/web/src/components/delivery/` reviewed by hand).
- [ ] Push (gh account gotcha) + PR per repo convention. PR body notes: 5-locale i18n (ja included — spec said 4), leaderboard column display-only deviation, zh-CN/ja/ko translations ride #134 native-review debt, feature still dark; NEXT = release+deploy+live-smoke+flag-flip (operator sequence from the spec's Migrations & rollout + #270 pre-flip list). No `Close #NN`.
- [ ] Final whole-branch review (fable) before merge, as previous PRs.

## Coverage / deviation notes

- Leaderboard delivery column: display-only v1 (no click-sort — zero precedent in the codebase; per-cell fetch). Spec's "sortable" deferred; file under #270 if wanted.
- i18n ×5 (spec said 4 — ja catalog exists and parity test enforces it).
- The delivery tab is in-page state (no URL sub-route) — matches member detail's flat structure; deep-linking deferred.
- `EvaluationWindowSelect` reused as-is for delivery (92-day cap aligns with `MAX_GENERATE_WINDOW_DAYS`).
- No new API endpoints or RBAC actions — everything shipped in PR 2/3.
