# Caliber Observability Pack / Caliber 可觀測性套件

Prometheus + Grafana dashboards for the Caliber gateway. Drop into your Grafana provisioning directory and get instant insight into request capture, evaluator behavior, and GDPR / retention.

Caliber gateway 的 Prometheus + Grafana 儀表板。放到 Grafana provisioning 目錄即可立即觀察請求擷取、評核器、GDPR / 保留期限等狀態。

## What's in here / 內含

| Dashboard | UID | What it shows / 顯示內容 |
|---|---|---|
| Caliber — Body Capture | `caliber-body-capture` | Request capture rate, retention purge lag, purge tick duration / 請求擷取速率、保留期限清理延遲、清理週期耗時 |
| Caliber — Evaluator | `caliber-evaluator` | Rule-based + facet evaluation, DLQ depth, LLM cost per org / 規則評核與面向擷取、DLQ 深度、各組織 LLM 成本 |
| Caliber — GDPR | `caliber-gdpr` | Delete executions, auto-rejections, failure rate / 刪除執行、自動拒絕、失敗率 |

## Prerequisites / 前置需求

- Prometheus scraping the Caliber gateway `/metrics` endpoint. Sample scrape config in [`monitoring/prometheus/scrape.example.yml`](../../monitoring/prometheus/scrape.example.yml).
- Grafana 10+ (template variables + `folderUid` support).
- A Prometheus datasource registered in Grafana. Dashboards default to Grafana's `default` datasource alias, so if your Prometheus is the default datasource everything works without config. Otherwise pick from the **Data source** dropdown at the top of each dashboard.

- Prometheus 抓取 Caliber gateway 的 `/metrics`。範例 scrape 設定見 [`monitoring/prometheus/scrape.example.yml`](../../monitoring/prometheus/scrape.example.yml)。
- Grafana 10+（需 template variables 與 `folderUid`）。
- 已在 Grafana 註冊 Prometheus datasource。儀表板預設使用 Grafana 的 `default` datasource alias；若 Prometheus 為預設 datasource 則無需設定，否則於每個 dashboard 上方 **Data source** 下拉切換。

## Install — Option A: File provisioning (recommended) / 安裝—方法 A：檔案 provisioning（推薦）

Mount this directory + the provisioning manifest into your Grafana container:

將本目錄與 provisioning manifest 掛載進 Grafana container：

```yaml
# docker-compose.yml (excerpt)
grafana:
  volumes:
    - ./ops/grafana:/etc/grafana/provisioning/dashboards/caliber:ro
    - ./ops/grafana/provisioning/dashboards.yaml:/etc/grafana/provisioning/dashboards/caliber.yaml:ro
```

Restart Grafana:

重啟 Grafana：

```bash
docker compose restart grafana
```

A `Caliber` folder appears containing all 3 dashboards.

會出現 `Caliber` 資料夾，內含 3 個 dashboard。

## Install — Option B: UI import / 安裝—方法 B：UI 匯入

1. Grafana → Dashboards → New → Import
2. Paste the JSON content of `caliber-body-capture.json` (and the other two)
3. When prompted, pick your Prometheus datasource

1. Grafana → Dashboards → New → Import
2. 貼上 `caliber-body-capture.json`（及另外兩個）的 JSON 內容
3. 系統詢問時選擇你的 Prometheus datasource

## Required metrics / 所需指標

Dashboards assume the Caliber gateway emits these Prometheus metrics. Missing metrics yield empty panels (not fatal).

儀表板假設 Caliber gateway 提供下列 Prometheus 指標。缺少指標的面板會顯示空白（非致命錯誤）。

**Body capture:**
- `gw_body_capture_enqueued_total{result}` — capture-rate counter
- `gw_body_purge_lag_hours` — gauge: oldest overdue purge row, hours
- `gw_body_purge_deleted_total` — counter: rows deleted by purge cron
- `gw_body_purge_duration_seconds_bucket` — histogram of purge tick durations

**Evaluator:**
- `gw_eval_llm_called_total{result}` — evaluator LLM call counter
- `gw_eval_llm_failed_total{reason}` — LLM failure counter with reason label
- `gw_eval_llm_parse_failed_total` — JSON / schema parse failure counter
- `gw_eval_dlq_count` — DLQ depth gauge
- `gw_eval_llm_cost_usd` — cumulative evaluator cost counter
- `gw_facet_extract_total{org_id, result}` — facet extraction counter
- `gw_facet_extract_duration_ms_bucket{org_id}` — facet duration histogram
- `gw_facet_cache_hit_total{org_id}` — facet cache hits (misses inferred as `gw_facet_extract_total − gw_facet_cache_hit_total`)
- `gw_llm_cost_usd_total{org_id, event_type, model}` — per-org cost counter

**GDPR:**
- `gw_gdpr_delete_executed_total` — executions counter
- `gw_gdpr_bodies_deleted_total` / `gw_gdpr_reports_deleted_total` — per-table delete counters
- `gw_gdpr_auto_rejected_total` — auto-rejected (SLA expiry) counter
- `gw_gdpr_failures_total` — executor failure counter

The `org_id` label is only present on the evaluator's facet + cost metrics. Body-capture and GDPR metrics are global (no per-tenant breakdown). The dashboards reflect this — only `caliber-evaluator` has an `Org ID` filter.

`org_id` label 僅出現在 evaluator 的 facet 與 cost 系列指標上。Body-capture 與 GDPR 指標為全域（無 tenant 切分），故僅 `caliber-evaluator` 提供 `Org ID` 篩選。

## Panel ↔ Metric mapping / 面板對應指標

### Caliber — Body Capture

| Panel | PromQL |
|---|---|
| Capture rate (per result) | `sum by (result) (rate(gw_body_capture_enqueued_total[5m]))` |
| Capture rate (total) | `sum(rate(gw_body_capture_enqueued_total[5m]))` |
| Purge lag (hours) | `gw_body_purge_lag_hours` |
| Bytes deleted by purge (rate) | `sum(rate(gw_body_purge_deleted_total[1h]))` |
| Purge tick duration p50 | `histogram_quantile(0.50, sum by (le) (rate(gw_body_purge_duration_seconds_bucket[1h])))` |
| Purge tick duration p99 | `histogram_quantile(0.99, sum by (le) (rate(gw_body_purge_duration_seconds_bucket[1h])))` |

### Caliber — Evaluator

| Panel | PromQL |
|---|---|
| Job rate — completed | `sum(rate(gw_eval_llm_called_total{result="ok"}[5m]))` |
| Job rate — failed | `sum(rate(gw_eval_llm_failed_total[5m]))` |
| Parse failures | `sum(rate(gw_eval_llm_parse_failed_total[5m]))` |
| Failed by reason | `sum by (reason) (rate(gw_eval_llm_failed_total[5m]))` |
| DLQ depth | `gw_eval_dlq_count` |
| Evaluator LLM cost (USD/hour) | `increase(gw_eval_llm_cost_usd[1h])` |
| Facet extraction by result | `sum by (result) (rate(gw_facet_extract_total{org_id=~"$org_id"}[5m]))` |
| Facet duration heatmap | `sum by (le) (rate(gw_facet_extract_duration_ms_bucket{org_id=~"$org_id"}[5m]))` |
| Facet cache hit rate | hit / total over `gw_facet_cache_hit_total{org_id=~"$org_id"}` |
| LLM spend this month by org | `sum by (org_id) (increase(gw_llm_cost_usd_total[30d]))` |
| Top 5 spenders (30d) | `topk(5, sum by (org_id) (increase(gw_llm_cost_usd_total[30d])))` |

### Caliber — GDPR

| Panel | PromQL |
|---|---|
| Delete executions (rate) | `sum(rate(gw_gdpr_delete_executed_total[1h]))` |
| Bodies deleted | `sum(rate(gw_gdpr_bodies_deleted_total[1h]))` |
| Reports deleted | `sum(rate(gw_gdpr_reports_deleted_total[1h]))` |
| Auto-rejected requests | `sum(rate(gw_gdpr_auto_rejected_total[24h]))` |
| Failures (rate) | `sum(rate(gw_gdpr_failures_total[1h]))` |

## Customization / 自訂

- **Data source**: switch via the dropdown at the top of each dashboard. Default uses Grafana's `default` datasource alias.
- **Org ID** (`caliber-evaluator` only): pick one or more orgs, or `All` for cross-org aggregate.
- **Time window**: standard Grafana time picker.

- **Data source**：每個 dashboard 頂端下拉切換。預設用 Grafana 的 `default` alias。
- **Org ID**（僅 `caliber-evaluator`）：選單一或多個 org，或 `All` 跨組織彙整。
- **時間區間**：標準 Grafana 時間選擇器。

## Versioning / 版本

Each dashboard's `version` field bumps on every shape-changing PR. To keep local UI edits across an update:

每個 dashboard 的 `version` 欄位於每次形狀變動的 PR 遞增。如欲保留 UI 本機修改：

1. Set `allowUiUpdates: false` in `provisioning/dashboards.yaml`
2. Pull the new file manually and merge with your local edits

1. 將 `provisioning/dashboards.yaml` 的 `allowUiUpdates` 改為 `false`
2. 手動拉取新版檔案並與本機修改合併

## Contributing / 貢獻

PRs welcome. Open the dashboard in Grafana → JSON Model → paste back into the file. Bump `version` field. Update this README if you add/remove panels or change metric dependencies.

歡迎 PR。在 Grafana 開 dashboard → JSON Model → 貼回檔案。`version` 欄位記得 bump。若新增 / 移除面板或改了相依的 metric，請同步更新本 README。

## License / 授權

Inherits from the parent Caliber project license.

繼承自上層 Caliber 專案授權。
