# GitHub delivery scoring (independent track) — design

**Date:** 2026-07-15
**Status:** Approved (pending spec review)

## Problem

Members already sign in with GitHub (NextAuth GitHub provider), so the platform
knows exactly who they are on GitHub — `accounts.providerAccountId` stores the
stable numeric GitHub user id. But none of their delivery activity (PRs,
reviews, issues, GitHub Projects) is visible in Caliber. The operator today
merges "AI usage score" and "GitHub delivery data" **by hand** every quarter
(the `/ito-quarterly-scoring` flow). This feature automates that second track
inside Caliber.

## Decisions (approved 2026-07-15)

1. **Independent track, never summed.** GitHub delivery gets its own score and
   report, displayed side-by-side with the existing 120-point AI-usage score.
   The rubric-v2 evaluation pipeline and `evaluation_reports` are untouched.
2. **Access via org-level fine-grained PAT** (v1). An admin pastes a PAT with
   read-only Issues / Pull requests / Projects / metadata permissions into org
   settings. Encrypted at rest with the same envelope cipher used for upstream
   credentials (`packages/gateway-core/src/crypto/credentialCipher.ts`).
   GitHub App + webhooks are explicitly out of scope for v1.
3. **Quantitative skeleton + LLM quality layer in the same release.**
   Deterministic metrics scored with the existing continuous-curve engine,
   plus a bounded LLM quality adjustment (±15) from sampled merged-PR content,
   billed through the existing `llm_usage_events` ledger and org budget.

## Identity mapping (zero member action)

GitHub API payloads carry both `user.id` (numeric) and `user.login`. Activity
rows store **both**; attribution joins `author_gh_id::text =
accounts.providerAccountId WHERE provider = 'github'`. Numeric id is stable
across renames; `login` is display-only. Members never re-authenticate.
Activity by GitHub users with no matching Caliber account is synced but
unattributed (visible in org-level totals only).

## Component 1 — Connection (org settings)

New table `github_connections` (schema
`packages/db/src/schema/githubConnections.ts`):

- `id`, `org_id` (unique, FK cascade), `owner_login` (the GitHub org/user the
  PAT is scoped to — required, drives repo listing), `encrypted_pat` (envelope
  via `credentialCipher`), `token_last4`, `repo_allowlist` jsonb (null = all
  repos visible to the PAT), `delivery_enabled` boolean default true,
  `status` (`ok` | `auth_error` | `rate_limited` | `sync_error`),
  `last_sync_at`, `last_sync_error`, timestamps.

tRPC router `githubDelivery` (apps/api): `setConnection` (PAT write-only,
validated by a live `GET /octocat`-style probe + `GET /orgs/{owner}/repos`
before persisting), `getConnection` (returns last4 + status only, **never**
the token), `deleteConnection`, `syncNow`, `generate`, `getReport`,
`listActivity`. Admin-gated via the existing permission pattern; members can
read their own report.

## Component 2 — Sync worker (`github-sync`)

New BullMQ queue + worker `apps/gateway/src/workers/githubSync/` (queue name
`github-sync`), modeled on the evaluator queue module. Registration gated by
env `ENABLE_GITHUB_DELIVERY` (default false). Deterministic jobId
`sync-{orgId}` — **no colons** (BullMQ jobId lesson from #251-era evaluator
bug) — so repeat triggers dedup.

**Schedule:** repeatable job every 6 h per org with an enabled connection, plus
manual `syncNow` from settings.

**Fetch plan (REST unless noted):**

- Repos: `GET /orgs/{owner}/repos` (paginated), intersected with
  `repo_allowlist` when set.
- PRs: `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc`,
  stop paging when `updated_at` < per-repo watermark. For each new/updated PR,
  `GET .../pulls/{n}` (detail: additions/deletions/changed_files) and
  `GET .../pulls/{n}/reviews`.
- Issues: `GET /repos/{o}/{r}/issues?state=all&since={watermark}` (rows with a
  `pull_request` key are skipped). For issues closed since the watermark, one
  `GET .../issues/{n}` to capture `closed_by`.
- Projects v2 (GraphQL): `organization.projectsV2 → items` with status field
  values and assignees. Requires the PAT to have org **Projects: read**.

**Storage** (all upsert on `(org_id, gh_node_id)` unique; schema files under
`packages/db/src/schema/`):

- `github_pull_requests`: repo_full_name, number, gh_node_id, author_gh_id,
  author_login, state, draft, title, html_url, base_ref, additions, deletions,
  changed_files, commit_count, review_comment_count, gh_created_at, merged_at,
  closed_at, synced_at.
- `github_reviews`: gh_node_id, pr_gh_node_id, repo_full_name, reviewer_gh_id,
  reviewer_login, state (APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED),
  submitted_at.
- `github_issues`: repo_full_name, number, gh_node_id, author_gh_id/login,
  assignee_gh_ids jsonb, state, state_reason, closed_by_gh_id, title,
  html_url, gh_created_at, closed_at, synced_at.
- `github_project_items`: project_node_id, project_title, item_node_id,
  content_type, content_gh_node_id, assignee_gh_ids jsonb, status_value,
  is_done boolean (status in a terminal column), gh_updated_at, synced_at.
  *Known limitation:* Projects v2 exposes no `completed_at`; we record
  `gh_updated_at` when `is_done` flips and treat it as completion time.

Watermarks: `github_sync_state` table (org_id, repo_full_name, resource_type,
watermark timestamp). Diff content is **never** stored.

**Resilience:** per-repo try/catch — one failing repo doesn't abort the org
sync; failures aggregate into `last_sync_error`. 403/429 honour
`Retry-After` / `x-ratelimit-reset` with backoff; if the budget is exhausted
mid-sync the job reschedules itself and keeps the watermarks already advanced.
5000 req/h is ample for ~11 members / moderate repo counts.

## Component 3 — Quantitative delivery score

New module `packages/evaluator/src/delivery/` (rubric + metrics + scorer),
reusing `Curve`/`curveScore` from
`packages/evaluator/src/engine/continuousScorer.ts` — verified: it is a pure
linear map and descending curves (`zeroAt > fullAt`, "lower is better") invert
automatically (`continuousScorer.ts:11-15`).

`deliveryRubricV1` — code constants in v1 (no per-org override yet), scale
**max 120** to visually align with the AI-usage score (never summed with it):

| Section | Weight | Metrics (curve zeroAt → fullAt, per 30-day window, scaled linearly to the selected window length) |
|---|---|---|
| throughput | 40% | merged PR count (0→8) · issues closed as assignee-or-closer (0→10) · project items completed as assignee (0→10) |
| collaboration | 30% | reviews submitted (0→10) · distinct PRs reviewed (0→6) |
| timeliness | 30% | median PR lead time open→merge, hours (168→24, inverted) · median issue resolution days (14→2, inverted) |

Rules: raw commits are **not** counted (PR-centric by design); line counts are
never a metric (anti-gaming); draft PRs and self-reviews are excluded;
`insufficient_data = true` when the member has fewer than 3 total delivery
events (merged PRs + closed issues + reviews) in the window — rendered as 資料
不足, never as a zero score.

**Report storage** — `github_delivery_reports`, mirroring `evaluation_reports`
shape: org_id, user_id, period_start, period_end, period_type, total_score,
insufficient_data, section_scores jsonb, metrics jsonb (raw counts + curve
inputs, for explainability), llm_quality_adjustment, llm_narrative,
llm_evidence jsonb, llm_status (`ok` | `skipped` | `parse_error` |
`budget_denied`), llm_model, llm_called_at, llm_cost_usd, triggered_by,
timestamps. Unique on `(org_id, user_id, period_start, period_type)`.

**Trigger model** (aligned with the existing 7/30/90-day window UX):

- Manual: a "產生交付報告" button on the delivery tab enqueues a
  `github-delivery` job for the selected window (same deterministic-jobId
  dedup; window capped at 92 days like `reports.rerun`). If the last sync is
  older than 1 h it chains a sync first.
- Cron: weekly (Mon 03:00 server time, after the 6 h sync) generates the rolling
  30-day report for every attributed member. Quant-only recomputation is
  cheap SQL; the LLM layer runs per the sampling rules below.

## Component 4 — LLM quality layer

- **Sampling:** top **N=5** merged PRs in the window, ranked by
  `log(additions+deletions+1)` descending, tie-broken by `merged_at` descending. Diff fetched **at eval
  time** via `GET .../pulls/{n}` with the `.diff` media type — truncated
  per-file and to ~30k chars total — plus PR title/body and up to 20 review
  comments. Nothing from this fetch is persisted except the report fields.
- **Call path:** the gateway self-loopback `/v1/messages` with the org eval
  key **and the eval account-pin header** (same path the facet client uses
  post-hotfix — generalize `facetLlmClient` or extract a shared loopback
  client). Ledgered into `llm_usage_events` with a new event type
  `delivery_analysis`; org monthly budget enforcement identical to deep
  analysis (`budget_denied` → quant score stands, llm_status records why).
- **Output contract (strict JSON):** `{ qualityAdjustment: number ∈ [-15, 15],
  narrative: string, evidence: [{ repo, prNumber, quote, reason }] }`.
  Adjustment is clamped server-side regardless of model output; final total =
  `clamp(quantScore + qualityAdjustment, 0, 120)`.
- **Parse resilience (facet parse_error lesson):** strict output instruction +
  one retry on invalid JSON; on second failure set `llm_status =
  'parse_error'`, keep the quantitative score, never fail the report. Model
  choice follows the org's existing `llm_eval_model`.

## Component 5 — UI

- **Member detail** → new「交付產出」tab (`apps/web/src/components/delivery/`):
  score card (total + 3 section bars + LLM adjustment badge), metrics table
  with raw counts, PR/issue list linking back to GitHub, LLM narrative +
  evidence quotes, generate button (admin), window selector reusing
  `EvaluationWindowSelect`.
- **Team leaderboard**: second score column「交付分」next to the AI-usage
  score — sortable, never summed. Members without a report show 「—」.
- **Org settings** → GitHub 連線 section: PAT input (write-only field), owner
  login, repo allowlist picker, test-connection result, sync status /
  last-sync time / last error, manual sync button.
- i18n: all four catalogs (`en`, `zh-TW`, `zh-CN`, `ko`).

## Security & failure handling

- PAT: encrypted at rest (credentialCipher envelope), surfaced only as last4,
  **never logged and never returned by any API** — and add the
  `github_pat_*` token shape to `packages/gateway-core/src/logging/redact.ts`
  so a leak is caught even on error paths (2026-06-09 lesson: redaction must
  be explicit, not assumed).
- `auth_error` (401/403 token revoked/expired) pauses the schedule and
  surfaces prominently in settings; sync errors keep prior data intact.
- Unattributed members (no `github` row in `accounts` — shouldn't happen since
  login is GitHub-only): report row gets `insufficient_data` + a distinct
  `no_identity` note, not a zero.

## Out of scope (YAGNI)

GitHub App + webhooks/real-time sync; raw commit analysis; per-org
configurable delivery-rubric weights; merging the two scores into one number;
DORA-style deployment metrics; non-GitHub forges; per-key (project) delivery
grain; historical backfill beyond what list endpoints return by watermark
(first sync naturally pulls full history the API exposes).

## Testing

- **Unit** (packages/evaluator): metric calculators from fixture rows (incl.
  window scaling, draft/self-review exclusion, median math), inverted curves,
  insufficient-data threshold, PR sampler ranking, LLM response parser
  (valid / clamp-out-of-range / garbage → parse_error).
- **Integration** (testcontainers): sync worker against recorded GitHub JSON
  fixtures (mocked fetch) → tables populated, watermarks advance, per-repo
  failure isolation; delivery eval end-to-end with stubbed LLM → report row,
  ledger row, budget-denied path; tRPC router auth/permission cases; PAT
  never appears in any response or log line (assert on redaction).
- **Web**: delivery tab render states (ok / insufficient_data / parse_error /
  no report), settings connection flow, leaderboard column.
- **Live smoke on VPS before release** (the #251 lesson — green CI is not
  "it works"): real PAT on the real org, one full sync, one generated report
  including the LLM layer, verified in the browser.

## Migrations & rollout

- Migrations `0032` (+ `_down`): `github_connections`, `github_sync_state`,
  `github_pull_requests`, `github_reviews`, `github_issues`,
  `github_project_items`, `github_delivery_reports`.
- Env: `ENABLE_GITHUB_DELIVERY` (gateway worker registration; default false —
  same dark-launch pattern as `ENABLE_FACET_EXTRACTION`).
- Delivery order: PR 1 connection + sync worker + tables → PR 2 quant scoring
  + reports + API → PR 3 LLM layer → PR 4 UI. Each PR independently green and
  reviewable; feature stays dark until the VPS `.env` flag flips.
