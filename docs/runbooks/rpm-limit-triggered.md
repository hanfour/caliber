# GatewayApiKeyRpmLimitTriggered

## Severity

warning (single-key spike) | critical (broad 429s)

## Symptoms

- 429 responses returned by the gateway with body `{"error":"rate_limited", "limit":N, "window":"60s", "retryAfterSec":...}`.
- Customer-facing client logs show retry-after waits.
- `x-ratelimit-remaining: 0` in successful responses approaching the cap.
- `req.log` `"rate_limit_check_failed"` warns (Redis dip — fail-open path,
  not 429s).

## Likely causes

1. **Legitimate traffic growth** — a single user's batch job or new
   client integration genuinely exceeds the per-key cap.
2. **Misconfigured client** — runaway loop / no backoff on retry; the
   limit is doing its job.
3. **Limit set too low** — `GATEWAY_APIKEY_RPM_LIMIT` was tuned down at
   some point and stale relative to current traffic shape.
4. **Redis flake** — bucket counters incrementing oddly (rare; check the
   `rate_limit_check_failed` warn count).

## Diagnosis commands

```bash
# Check the current limit value the gateway booted with.
docker compose exec gateway sh -c 'echo "RPM limit: $GATEWAY_APIKEY_RPM_LIMIT"'

# Top apiKeys by 429 count over the last hour (from gateway access logs
# or the request_logs table if usage capture is on).
psql "$DATABASE_URL" -c "
  SELECT api_key_id, COUNT(*) AS rejects
  FROM usage_logs
  WHERE created_at > NOW() - INTERVAL '1 hour'
    AND status_code = 429
  GROUP BY api_key_id ORDER BY rejects DESC LIMIT 10;
"

# Inspect a specific key's bucket counter (replace <id>).
docker compose exec redis redis-cli --scan --pattern 'aide:gw:rl:apikey:<id>:*'
docker compose exec redis redis-cli get 'aide:gw:rl:apikey:<id>:<minute-bucket>'
docker compose exec redis redis-cli ttl 'aide:gw:rl:apikey:<id>:<minute-bucket>'

# Look for the fail-open warns (Redis side-effect) — should be 0 in normal ops.
docker compose --profile gateway logs gateway --since 1h \
  | grep rate_limit_check_failed | wc -l
```

## Resolution steps

### Single legitimate user exceeded the cap
1. Talk to the user — confirm their workload is intentional and won't
   abuse upstream quotas if raised.
2. Decide whether to:
   - Raise `GATEWAY_APIKEY_RPM_LIMIT` globally (affects all keys; fine
     if your gateway has headroom), OR
   - Issue them a second `ak_` key for the same user (each key has its
     own bucket — operationally simple), OR
   - Plan: per-key custom limit (Phase 3 #2 follow-up; not in code today).
3. If raising globally: edit `docker/.env`, restart gateway:
   ```sh
   sed -i '' 's/^GATEWAY_APIKEY_RPM_LIMIT=.*/GATEWAY_APIKEY_RPM_LIMIT=1200/' docker/.env
   docker compose --profile gateway up -d gateway
   ```
4. Validate with a test call — `x-ratelimit-limit` header reflects the
   new value.

### Misconfigured client
1. Show the user the `Retry-After` header — they likely aren't
   honouring it.
2. Revoke + reissue if the runaway is unrecoverable. `accounts.delete`
   on the apiKey or revoke via Admin UI.

### Limit too low
1. Pull the last 30 days of legitimate request volume to right-size:
   ```sql
   SELECT api_key_id,
          MAX(per_minute) AS peak_rpm,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY per_minute) AS p99
   FROM (
     SELECT api_key_id, date_trunc('minute', created_at) AS m, COUNT(*) AS per_minute
     FROM usage_logs WHERE created_at > NOW() - INTERVAL '30 days' AND status_code < 400
     GROUP BY api_key_id, m
   ) sub GROUP BY api_key_id ORDER BY peak_rpm DESC LIMIT 20;
   ```
2. Set `GATEWAY_APIKEY_RPM_LIMIT` to roughly `1.5 × p99` of the busiest
   legitimate key.

### Redis flake
1. If `rate_limit_check_failed` warns are non-zero, fail-open is
   protecting traffic but the rate limit isn't enforcing.
2. Check Redis health: `docker compose exec redis redis-cli ping`
3. Restart Redis if unresponsive: `docker compose restart redis`
4. Rate limit re-engages on next request (no state loss except the
   in-flight bucket counters, which expire in ≤60s anyway).

## Escalation

- Sustained `rate_limit_check_failed > 1/min` for 5+ minutes →
  page infra oncall (Redis health is degraded).
- Org admin disputes a 429 they believe is wrong → check the bucket
  key TTL and count; if both look healthy, the client is exceeding the
  cap. Send them the diagnostic query above.

## Related

- `apps/gateway/src/middleware/rateLimitPlugin.ts` — request-time gate
- `apps/gateway/src/redis/rateLimit.ts` — bucket increment helper
- `docs/GATEWAY.md#2-configuration` — the env knob's reference table
