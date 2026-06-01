# GDPRExecutorFailures / GDPRAutoRejectionSpike

## Severity
warning

## Symptoms
- `gw_gdpr_failures_total` is incrementing on the Caliber — GDPR dashboard.
- `gw_gdpr_auto_rejected_total` is non-zero (a request hit the 30-day SLA).
- Customer support reports a user complaining their delete request hasn't been honored.

## Likely causes
1. The 5-min GDPR delete cron is failing on a specific request (FK violation, row doesn't exist, etc.).
2. `request_bodies` deletion is timing out due to locks / very large batches.
3. The daily expiry cron is mis-scheduled or the gateway was offline for >24h, causing a batch of stale requests to expire at once.
4. An admin approved a request but the executor can't load the requesting user's scope (org deleted, user deleted).

## Diagnosis commands

```bash
# Confirm both crons are registered
docker compose logs gateway 2>&1 | grep -E "gdpr (delete|expire) cron registered"

# Recent failures
docker compose logs --tail=500 gateway | grep -iE 'gdpr.*(fail|error)'

# Pending delete requests near or past SLA
psql "$DATABASE_URL" -c "
  SELECT id, user_id, status, requested_at,
         NOW() - requested_at AS age,
         last_error
  FROM gdpr_delete_requests
  WHERE status IN ('pending','approved','failed')
  ORDER BY requested_at ASC LIMIT 20;
"

# How many auto-rejected in the last 7 days?
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM gdpr_delete_requests
  WHERE status='auto_rejected' AND updated_at > NOW() - INTERVAL '7 days';
"
```

## Resolution steps
1. For each `failed` request: read `last_error`. Common patterns: missing row (idempotent — mark complete), lock timeout (retry), permission error (escalate).
2. Reset failed requests with `UPDATE gdpr_delete_requests SET status='approved', last_error=NULL WHERE id=...` to retry on the next cron tick.
3. For auto-rejected requests within SLA window, manually re-approve via the admin UI and re-run.
4. Confirm no new failures within 1 hour.

## Escalation
- ALWAYS notify DPO when a request was auto-rejected — they may need to communicate with the data subject.
- If failures persist >2h or affect >5 requests, page on-call and treat as a P1 compliance incident.
- Document every auto-rejection in the compliance log.
