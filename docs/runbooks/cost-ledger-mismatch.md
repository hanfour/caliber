# CostLedgerVsAnthropicDrift

## Severity
warning

## Symptoms
- `gw_billing_drift_total` increased in the last 24h.
- Monthly cost dashboard shows a different total than the Anthropic console for the same period.
- Customer disputes a budget alert: "I haven't used that much".

## Likely causes
1. `gw_pricing_miss_total` is non-zero — the pricing table is missing entries for new models, so the ledger under-charged.
2. Body-capture / evaluator job double-billed (rare; would manifest as ledger > Anthropic).
3. Anthropic billing event timezone differs from our `occurred_at` truncation; month boundary skew.
4. A reprice job ran and updated historical rows but the MTD aggregate cache wasn't invalidated.

## Diagnosis commands

```bash
# Recent drift detections from the hourly audit
docker compose logs gateway 2>&1 | grep -i 'billing drift' | tail -50

# Ledger month-to-date total per org
psql "$DATABASE_URL" -c "
  SELECT org_id,
         SUM(cost_usd) AS ledger_mtd
  FROM cost_ledger
  WHERE occurred_at >= date_trunc('month', NOW())
  GROUP BY org_id
  ORDER BY ledger_mtd DESC LIMIT 20;
"

# usage_logs reconciliation (per Plan 4A audit)
psql "$DATABASE_URL" -c "
  SELECT api_key_id,
         SUM(total_cost) AS logs_total,
         (SELECT quota_used_usd FROM api_keys WHERE id = ul.api_key_id) AS quota_used
  FROM usage_logs ul
  GROUP BY api_key_id
  HAVING ABS(SUM(total_cost) - (SELECT quota_used_usd FROM api_keys WHERE id = ul.api_key_id)) > 0.01
  LIMIT 20;
"

# Pricing misses
curl -s http://gateway:3002/metrics | grep gw_pricing_miss_total
```

## Resolution steps
1. Pull the Anthropic billing CSV for the same period and reconcile per `(model, day)`.
2. For pricing misses: add the missing model to the pricing table, then run a backfill repricer (`pnpm -F @caliber/api admin:reprice --since=YYYY-MM-DD`).
3. For double-billing: identify the duplicate `(idempotency_key, model, occurred_at)` rows in `cost_ledger` and delete the duplicates inside a transaction.
4. For timezone skew: confirm both sides use UTC; this is typically a one-off difference of a few cents and self-corrects next month.
5. After fix, re-run the hourly audit by restarting the gateway audit job.

## Escalation
- Drift >$10/org/day: notify finance and the org's billing contact within 1 business day.
- Drift >$100 systemwide: treat as a P2 incident and write an internal post-mortem.
- Always document the root cause and reconciliation amount in the finance log.
