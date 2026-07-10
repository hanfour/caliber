# Evaluator

The **Caliber evaluator** is an opt-in subsystem that captures user interactions
(messages, code, terminal sessions) and scores them against configurable rubrics.
It powers member feedback, team insights, and organizational transparency on
code quality and collaboration patterns.

Scoring uses two modes: fast rule-based checks + optional LLM Deep Analysis
for nuanced assessment. All capture is encrypted at rest and tied to explicit
member consent.

> Status: ships in **v0.4.0** as Plan 4B. Opt-in behind `ENABLE_EVALUATOR=true`.
> Requires the gateway + body capture (Plan 4A) to function.

---

## 1. Architecture overview

The evaluator has three layers:

1. **Capture** (gateway) — encrypted storage of request bodies in
   `credential_vault` with AES-256-GCM + HKDF domain separation; 90-day
   default retention; GDPR delete/export workflows.
2. **Scoring** (worker pool) — rule-based scoring off the captured bodies +
   optional LLM Deep Analysis calls to a provisioned API account; results
   stored in `member_scores` + `score_evidence`.
3. **Transparency** (UI) — members see their own 30-day trend, rules breakdown,
   and a growth-oriented report on `/dashboard/profile/evaluation`; org admins
   see team aggregates plus a deeper management report on
   `/dashboard/organizations/[id]/teams/[tid]`.

### Audience-specific reports

When LLM Deep Analysis is enabled, one evaluation call produces two structured
views from the same rubric and score evidence:

- **User report** — summary, strengths, growth areas, and concrete next steps.
  It excludes organization comparisons, raw LLM evidence, request IDs, model
  cost, and upstream-account diagnostics.
- **Admin report** — executive summary, deeper rubric assessment, evidence-linked
  concerns, coaching plan, calibration notes, and explicit data limitations.
  It is available only to callers with `report.read_org` for that organization.

The API selects the audience on the server and returns only one
`generatedReport`; the other stored payload is cleared before serialization.
Team managers without org-admin permission receive the existing redacted view.
Legacy rows generated before migration `0028_audience_reports` continue to use
the original narrative fallback.

**Workspace packages.**

| Package | Role |
|---|---|
| `apps/gateway` | Body capture + encryption, GDPR delete worker |
| `apps/api` | Rubric CRUD, score results, GDPR approval/rejection |
| `apps/web` | Evaluation pages, rubric editor, dry-run preview, GDPR flows |
| `packages/gateway-core` | Scoring engine (rule interpreter, LLM prompt generation) |
| `@caliber/db` | Schema: `rubrics`, `member_scores`, `score_evidence`, `gdpr_requests` |

---

## 2. Opt-in capture process

**Admin flow.**

1. Org admin opens `/dashboard/organizations/[id]/settings` → Evaluator tab
2. Toggle **Enable body capture** (off by default)
3. System prompts for: org banner message (shown to members), retention days
   (default 90), optional "eval mode" label (for A/B testing)
4. Save. Backend sets `orgs.capture_enabled = true` + stores metadata.
5. Members see a banner on their dashboard: *"Your interactions are being
   evaluated to provide feedback. See details."* — links to
   `/dashboard/profile/evaluation`.

**Member transparency.**

On `/dashboard/profile/evaluation`, members see:
- Consent toggle: "I understand my interactions are captured" (with export/delete
  links below)
- 30-day score trend (chart)
- Breakdown of scores by rubric rule
- A personal report with strengths, growth areas, and recommended next steps
- Transparent rule-signal details for the member's own score
- Export data button (triggers GDPR export workflow)
- Delete data button (triggers GDPR delete request)

---

## 3. Rubric customization

An **org-custom rubric** defines scoring rules and LLM prompts. Admins create
rubrics via `/dashboard/organizations/[id]/evaluator/rubrics`.

**Rubric schema** (JSON, stored in `rubrics.config`):

```json
{
  "name": "Code Quality v1",
  "description": "Evaluates code patterns",
  "rules": [
    {
      "id": "rule_deep_thinking",
      "name": "Deep thinking",
      "type": "llm",
      "weight": 1.0,
      "prompt": "Does this code show evidence of careful design? Rate 1–10.",
      "model": "claude-opus-4-5",
      "enabled": true
    },
    {
      "id": "rule_error_handling",
      "name": "Error handling",
      "type": "rule",
      "weight": 0.8,
      "pattern": "try|catch|error|throw",
      "enabled": true
    }
  ],
  "scoring_range": [0, 100],
  "version": "1"
}
```

**Rule types:**
- `rule` — regex or keyword match on body text
- `llm` — send body + prompt to a provisioned model; extract score from
  completion

**Dry-run feature.**

Before rolling out a rubric, admins preview on sample captured bodies:

1. Open the rubric editor
2. Click **Dry run**
3. Select sample bodies (from last 7d, all members or a team)
4. System runs the rubric rules + LLM calls (read-only, no score persisted)
5. Preview shows: matched rules, extracted scores, sample evidence

---

## 4. LLM Deep Analysis enable path

To score using `type: "llm"` rules, admins must:

1. Open `/dashboard/organizations/[id]/evaluator/settings` → LLM Deep Analysis
   section
2. Enter a **dedicated API key** (new or existing; best practice: new key per
   org)
3. Select **account scope** (org-wide or team override)
4. Pick **model** (dropdown: claude-opus-4-5, claude-sonnet-4-5, etc.)
5. Optionally set **rate limit** (requests/minute)
6. Save. Backend stores the key in `credential_vault` (encrypted, same as
   gateway accounts).

At scoring time, the worker retrieves the key, crafts a prompt from the rubric,
and calls Anthropic. Costs are tracked in `gw_eval_llm_cost_usd` metric +
organization `eval_spending_usd` field.

---

## 5. Member transparency flow

**See your own scores.**

- Navigate to `/dashboard/profile/evaluation`
- View 30-day trend chart
- Click any rule to see sample evidence (redacted messages, code snippets)
- Optional: **export my data** or **request deletion** (§6 below)

**Team admins see aggregates.**

- `/dashboard/organizations/[id]/teams/[tid]` → Evaluator tab
- Leaderboard (if enabled in rubric settings): sorted by average score
- Distribution histogram: score ranges across the team
- Org-admin drill-down: click a member → admin report, evidence-linked concerns,
  coaching plan, calibration notes, and data limitations
- Team managers retain aggregate/redacted access and do not receive either
  subject-level LLM audience payload

---

## 6. GDPR export/delete

**Member export.**

1. Member opens `/dashboard/profile/evaluation` → **Export my data**
2. Dialog: confirm scope (all interactions? last N days?)
3. System enqueues a job, returns confirmation email
4. Background worker packages:
   - Captured bodies (plaintext or JSON)
   - All scores + evidence + timestamps
   - Metadata (which rubrics, which models)
5. Creates zip, uploads to org's cloud storage or email, sends download link

**Member delete request.**

1. Member opens `/dashboard/profile/evaluation` → **Request deletion**
2. Dialog: reason (optional), scope
3. System creates a `gdpr_requests` row with `status='pending'`
4. Sends notification to org admins (email + in-app alert on
   `/dashboard/organizations/[id]/members`)
5. Admin approves or rejects with a note (e.g. "audit hold — contact legal")
   - Approval → worker purges bodies + scores + deletes from tables
   - Rejection → request archived, member notified

Default SLA: admins must respond within 30 days or it auto-approves.

---

## 7. Runbook

### Operational signals (metrics on `GET /metrics`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `gw_body_capture_enqueued_total` | counter | `result` (`success`\|`error`) | Requests captured to the queue |
| `gw_body_purge_deleted_total` | counter | — | Rows deleted by GDPR worker |
| `gw_body_purge_lag_hours` | gauge | — | Age of oldest unclaimed deletion |
| `gw_eval_llm_called_total` | counter | `result` (`success`\|`error`) | LLM calls for Deep Analysis |
| `gw_eval_llm_cost_usd` | counter | `model` | Cost accrued per model |
| `gw_eval_dlq_count` | gauge | — | Scoring jobs in dead-letter queue |
| `gw_gdpr_export_enqueued_total` | counter | `result` | Export jobs started |
| `gw_gdpr_delete_pending_count` | gauge | — | Pending deletion requests |
| `gw_gdpr_delete_approved_total` | counter | — | Completed deletions |

### Common issues

**Dry-run LLM calls fail**

Check that the org has a valid Deep Analysis API key configured. Verify the
key is not revoked and the account is within rate limits.

**Scores not updating**

- Check `gw_eval_dlq_count` — if > 0, inspect failed jobs for constraint
  violations (orphaned captures, missing rubrics).
- Verify `ENABLE_EVALUATOR=true` and `ENABLE_GATEWAY=true` in env.
- Check queue depth: if very high, scale the scoring worker pool.

**Member sees "No evaluations yet"**

- Verify capture is enabled for their org
  (`orgs.capture_enabled = true`).
- Check that at least one rubric is attached to the org.
- Scores lag behind capture by ~5 min (worker batch time). Wait and refresh.

**GDPR delete pending too long**

Run:

```sql
SELECT id, member_id, requested_at, status
FROM gdpr_requests
WHERE status = 'pending'
  AND requested_at < now() - interval '30 days'
ORDER BY requested_at;
```

Auto-approve stale ones:

```sql
UPDATE gdpr_requests
SET status = 'approved', approved_at = now()
WHERE status = 'pending'
  AND requested_at < now() - interval '30 days';
```

Then trigger the delete worker.

---

## 8. Configuration

| Env | Required when | Default | Purpose |
|---|---|---|---|
| `ENABLE_EVALUATOR` | always | `false` | Feature flag. Gating token for all evaluator routes + jobs. |
| `EVALUATOR_WORKER_THREADS` | scoring active | `4` | Parallel scoring jobs. |
| `EVALUATOR_BATCH_SIZE` | scoring active | `50` | Bodies to score per batch. |
| `EVALUATOR_RETENTION_DAYS` | `ENABLE_EVALUATOR=true` | `90` | Default data retention before purge. |
| `CREDENTIAL_ENCRYPTION_KEY` | `ENABLE_EVALUATOR=true` | — | Shared master (also used by gateway). AES-256-GCM sub-keys derived per captured body. |

---

## 9. LLM cost control (v0.5.0)

Plan 4C adds a per-org monthly USD budget on combined LLM spend (deep
analysis + facet extraction). Budget is set via
`organizations.llm_monthly_budget_usd`; overage behaviour
(`organizations.llm_budget_overage_behavior`) is either `degrade` (skip
the over-budget call, keep rule-based scoring) or `halt` (set
`llm_halted_until_month_end` and refuse all LLM calls until the next
UTC month). Every successful LLM call writes an immutable row to
`llm_usage_events` (org, event_type, model, tokens, cost, ref_type,
ref_id), forming an audit trail that the budget enforcer reads back to
compute month-to-date spend. Admins see live spend on
`/admin/evaluator/costs`. See the runbook at
[`runbooks/llm-budget.md`](./runbooks/llm-budget.md) for warn / breach
response procedures.

## 10. LLM facet extraction (v0.5.0)

Off by default. Two-level opt-in: server-wide
`ENABLE_FACET_EXTRACTION=true` plus per-org `llm_facet_enabled=true`
with a configured `llm_facet_model` (Haiku is recommended — facet
outputs are short JSON). When enabled, the evaluator worker classifies
each captured session against a fixed schema (session type, outcome,
helpfulness 1–5, friction / bugs caught / codex errors counts) and
persists the result in `request_body_facets`. The six facet signal
aggregators in `@caliber/evaluator/signals/facet.ts`
(`facet_session_type_mix`, `facet_outcome_distribution`,
`facet_avg_helpfulness`, `facet_friction_rate`,
`facet_bugs_caught_total`, `facet_codex_error_rate`) are then available
to rubrics. Cache key is `(request_id, prompt_version)` so re-runs at
the same prompt version are free. See
[`runbooks/facet-extraction.md`](./runbooks/facet-extraction.md) and
[`runbooks/facet-parse-errors.md`](./runbooks/facet-parse-errors.md).

## 11. Further reading

- Design doc: [`.claude/plans/2026-04-20-plan4b-evaluator-design.md`](./.claude/plans/2026-04-20-plan4b-evaluator-design.md)
  — full architecture, score aggregation model, LLM prompt engineering.
- Implementation plan: [`.claude/plans/2026-04-20-plan-4b-evaluator.md`](./.claude/plans/2026-04-20-plan-4b-evaluator.md)
  — 55 tasks × 14 parts with TDD rhythm.
- Plan 4C design / impl: [`.claude/plans/2026-04-24-plan-4c-design.md`](./.claude/plans/2026-04-24-plan-4c-design.md),
  [`.claude/plans/2026-04-24-plan-4c-implementation.md`](./.claude/plans/2026-04-24-plan-4c-implementation.md).
- v0.5.0 upgrade guide: [`UPGRADE-v0.5.0.md`](./UPGRADE-v0.5.0.md).
- Gateway + body capture: [`GATEWAY.md`](./GATEWAY.md) § 11 (Body Capture).
- Local development: [`../apps/gateway/README.md`](../apps/gateway/README.md).
