# Evaluator Rollout Runbook

This runbook walks through enabling the evaluator subsystem (Plan 4B) on a live deployment.

## Prerequisites

- Gateway deployed and serving traffic (Plan 4A complete).
- `CREDENTIAL_ENCRYPTION_KEY` configured and stable across restarts.
- Access to update env vars + redeploy services.

## Step 1 — Pull v0.4.0

Upgrade deployment to Caliber v0.4.0:
- `caliber-api:v0.4.0`
- `caliber-gateway:v0.4.0`
- `caliber-web:v0.4.0`

## Step 2 — Set ENABLE_EVALUATOR=true

Add to api + gateway + web env files:

    ENABLE_EVALUATOR=true
    GATEWAY_LOCAL_BASE_URL=http://gateway:3002   # optional; defaults to localhost

Redeploy api + gateway + web (in that order).

> **What this enables at startup:**
> - `wireBodyCapturePipeline` — BullMQ queue for capturing request bodies
> - `wireEvaluatorPipeline` — BullMQ queue + worker for LLM evaluation
> - `startBodyPurgeCron` — 4h cadence, purges expired `request_bodies` rows
> - `startEvaluatorCron` — daily 00:05 UTC, enqueues evaluation jobs for all users in active orgs
> - `startGdprDeleteCron` — 5min cadence, executes approved GDPR delete requests
> - `startGdprExpireCron` — daily, auto-rejects pending GDPR requests older than 30 days
>
> When `ENABLE_EVALUATOR=false` (the default), none of the above start. The API's `evaluatorProcedure` also blocks all evaluator tRPC routes independently.

## Step 3 — Run migration 0002

    pnpm -F @caliber/db db:migrate

Verifies:
- 4 new tables: `rubrics`, `request_bodies`, `evaluation_reports`, `gdpr_delete_requests`
- 10 new columns on `organizations`

> Note: the migration is safe to run before setting `ENABLE_EVALUATOR=true` — schema lands unconditionally.

## Step 4 — Verify cron + worker registered

Hit gateway `/metrics` endpoint and confirm the following series exist (with zero values):

    gw_body_purge_deleted_total
    gw_body_capture_enqueued_total
    gw_eval_llm_called_total
    gw_eval_dlq_count
    gw_gdpr_delete_executed_total
    gw_gdpr_auto_rejected_total

In logs you should see:

    evaluator cron registered (daily 00:05 UTC)
    body purge cron registered (4h cadence)
    gdpr delete cron registered (5min cadence)

## Step 5 — Enable on first pilot org

1. Log in as `super_admin`
2. Navigate to `/dashboard/organizations/[pilotOrgId]/evaluator/settings`
3. Toggle "Content capture enabled" ON
4. (Optional) Toggle "LLM Deep Analysis" + provision account + model
5. Click "Save"

Verify the audit log captures the first-enable event (`content_capture.enabled` action).

## Monitoring

Watch these metrics after enabling:
- `gw_body_capture_enqueued_total{result="queued"}` — should grow as pilot org generates traffic
- `gw_body_purge_lag_hours` — should stay near 0
- `gw_eval_dlq_count` — should stay at 0

If any of these drift, check the Troubleshooting section of `docs/EVALUATOR.md`.

## Rollback

To disable:
- Set `ENABLE_EVALUATOR=false` + redeploy.
- Data captured during rollout is preserved. Access via `gdpr_delete_requests` workflow if opt-out is needed.
