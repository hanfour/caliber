# aide monitoring + alerting

Drop-in Prometheus alert rules + scrape config that hook the
runbooks under `docs/runbooks/` to actual signals.

## What's here

| File | Purpose |
|---|---|
| `prometheus/alerts.yml` | Alerting rules — every alert names a `runbook` annotation pointing at the relevant `.md` |
| `prometheus/scrape.example.yml` | Sample scrape config (drop into your existing `prometheus.yml`) |

## Wire up

1. **Confirm metrics surface is reachable**
   ```sh
   curl -s http://gateway:3002/metrics | head -20
   curl -s http://api:3001/metrics    | head -20
   ```
   Both services expose `prom-client` standard runtime metrics
   (`nodejs_*`, `process_*`) plus the custom `gw_*` metrics defined
   in `apps/gateway/src/plugins/metrics.ts` (gateway side; api today
   only ships fastify-metrics defaults).

2. **Add scrape jobs to your Prometheus**
   Merge `scrape.example.yml` into the `scrape_configs:` of your
   `prometheus.yml`. For docker-compose self-hosting the targets
   resolve via Docker's internal DNS; for managed deploys see the
   target hostname comment in the file.

3. **Load the alert rules**
   Reference `alerts.yml` from your `prometheus.yml`:
   ```yaml
   rule_files:
     - /etc/prometheus/aide-alerts.yml
   ```
   Reload Prometheus (`SIGHUP` or `/-/reload`).

4. **Verify rules loaded**
   ```sh
   curl -s http://prometheus:9090/api/v1/rules | jq '.data.groups[].name'
   ```
   Should list `aide-liveness`, `aide-rate-limit`, `aide-failover`,
   `aide-oauth`, `aide-workers`, `aide-billing`, `aide-gdpr`.

5. **Wire Alertmanager → notification channel**
   Recommended routing:
   - `severity=critical` → page on-call (PagerDuty / Opsgenie)
   - `severity=warning` → Slack / email during business hours
   - `severity=info` → silent / dashboard-only

   Templates can render the `runbook` annotation as a clickable link
   in the notification — encourage operators to consult the runbook
   before escalating.

## Severity model

| Tier | Examples | Response |
|---|---|---|
| `critical` | gateway down, all upstreams failed, GDPR delete failure | Page on-call immediately |
| `warning` | rate-limit tripping, queue near saturation, OAuth account dead, pricing miss | Notify during business hours |
| `info` | LLM budget warning, evaluator DLQ growth | Dashboard, no notification |

## Known gaps

These would-be-useful alerts aren't shipped yet:

- **Cache hit rate** — no `gw_cache_hit_total` / `gw_cache_miss_total`
  metric exists today. Currently only observable via the `x-cache`
  response header. Adding the metric is a one-PR follow-up.
- **Rate-limit fail-open count** — `rate_limit_check_failed` is logged
  but not metricked. Same one-PR fix.
- **Backup freshness** — runbook prescribes daily pg_dumpall but no
  alert if a backup is missed; needs a node-exporter textfile collector
  on the backup host.
- **Cert expiry** — your reverse proxy's TLS cert. Use Prometheus
  blackbox-exporter (`probe_ssl_earliest_cert_expiry`) on the public
  endpoints.

These aren't blockers for first deploy — the current rule set covers
the high-impact failure modes the runbooks cover.

## Optional: Grafana

Sample dashboards are not shipped — the existing metric surface is
small enough that Grafana's "Add new panel" flow + Prometheus query
autocomplete gets you a useful dashboard in 15-20 min. A starter
shopping list:

- Request rate & status mix (`http_requests_total`)
- p50/p95/p99 latency (`http_request_duration_seconds_bucket`)
- Upstream account selection mix (`gw_scheduler_select_total`)
- Slot acquire success rate (`gw_slot_acquire_total{result}`)
- Queue depth + DLQ count (`gw_queue_depth`, `gw_queue_dlq_count`)
- LLM cost per org (`gw_llm_cost_usd_total`)
