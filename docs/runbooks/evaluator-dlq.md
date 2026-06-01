# EvaluatorDLQBacklog / EvaluatorDLQCritical

## Severity
warning (>10 for 15m) | critical (>50 for 5m)

## Symptoms
- `gw_eval_dlq_count` panel on the Caliber — Evaluator dashboard is climbing.
- Org admins report missing or stale evaluation reports for the last 24h cron run.
- The "Job rate" panel shows `failed` series spiking while `completed` flatlines.

## Likely causes
1. Anthropic / OAuth account is rejecting requests (token expired, account credit exhausted, model deprecated).
2. A poison job is hitting a deterministic exception (e.g. malformed `request_bodies` row, missing rubric).
3. Worker process crashed or is throttled and BullMQ is moving jobs to `failed` after retries.
4. Database is unhealthy and the worker can't write `evaluation_reports`.

## Diagnosis commands

```bash
# Recent worker logs
docker compose logs --tail=200 gateway | grep -E 'eval(uator)?|bullmq|dlq'

# Inspect the failed jobs in BullMQ
docker compose exec gateway node -e "
  const { Queue } = require('bullmq');
  const q = new Queue('evaluator', { connection: { url: process.env.REDIS_URL } });
  q.getJobs(['failed'], 0, 19).then(js => {
    for (const j of js) console.log(j.id, j.failedReason, j.attemptsMade);
    process.exit();
  });
"

# Check OAuth account / pricing for the org
psql "$DATABASE_URL" -c "SELECT id, status, last_error FROM oauth_accounts ORDER BY updated_at DESC LIMIT 10;"
```

## Resolution steps
1. Identify the failure pattern from `failedReason`. Group by message — usually 1-2 root causes.
2. If OAuth/credit related: refresh the token via the admin UI or top up; then `bullmq` retry the failed jobs.
3. If poison job: capture the job payload, file a bug, then `q.clean(0, 1000, 'failed')` to drain.
4. If transient (Anthropic 5xx): wait one cron cycle, then bulk-retry from the BullMQ UI.
5. Re-check `gw_eval_dlq_count` returns to 0 within 30 minutes.

## Escalation
- Critical (>50 for 5m): page the on-call engineer immediately.
- If Anthropic is the root cause and outage exceeds 1h, post to the org-wide status page.
- If a poison-job pattern looks GDPR-relevant (PII in `failedReason`), loop in DPO.
