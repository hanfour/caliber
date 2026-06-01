# BodyPurgeLagging / BodyPurgeLaggingCritical

## Severity
warning (>6h for 30m) | critical (>24h for 15m)

## Symptoms
- `gw_body_purge_lag_hours` is non-zero and growing on the Caliber — Body Capture dashboard.
- `request_bodies` table size is growing faster than expected.
- DPO dashboard reports retention SLA breaches.

## Likely causes
1. The 4h purge cron is not firing — `ENABLE_EVALUATOR=false` after a deploy, or the cron job died.
2. Purge tick is timing out because a single batch is too large.
3. Database autovacuum is starving the DELETE statement; locks pile up.
4. `retention_until` was set wrong (NULL or very old), creating a backlog the cron can't catch up on.

## Diagnosis commands

```bash
# Confirm the cron is registered
docker compose logs gateway 2>&1 | grep "body purge cron registered"

# Oldest overdue row
psql "$DATABASE_URL" -c "
  SELECT MIN(retention_until) AS oldest_overdue, COUNT(*) AS overdue_count
  FROM request_bodies
  WHERE retention_until < NOW();
"

# Recent purge tick durations (should be <60s)
curl -s http://gateway:3002/metrics | grep -E 'gw_body_purge_(duration|deleted|lag)'

# Look for lock contention
psql "$DATABASE_URL" -c "
  SELECT pid, now() - query_start AS age, state, query
  FROM pg_stat_activity
  WHERE state != 'idle' AND query ILIKE '%request_bodies%'
  ORDER BY age DESC LIMIT 10;
"
```

## Resolution steps
1. Confirm `ENABLE_EVALUATOR=true` and the gateway log shows "body purge cron registered (4h cadence)".
2. If overdue rows >100k, manually run the purge in smaller batches:
   ```sql
   DELETE FROM request_bodies WHERE retention_until < NOW() LIMIT 5000;
   ```
   Repeat until the overdue count is <1000, then let the cron resume.
3. If cron is registered but not running, restart the gateway container — cron registration is at boot.
4. Verify `gw_body_purge_lag_hours` returns to ~0 within 2 cron cycles (~8h).

## Escalation
- Critical (>24h): DPO must be informed in writing — retention SLA may be breached.
- If the underlying cause is DB perf, escalate to platform-eng and consider scheduling a manual purge during low-traffic window.
