# Grafana Observability Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-ship the three `ops/grafana/*.json` dashboards as a self-contained Caliber Observability Pack any operator can drop into Grafana via volume mount + restart. Closes #124.

**Architecture:** Git-rename the 3 dashboards to `caliber-<scope>.json`, edit in place (UID / title / tags / folder / datasource templating / org_id filter on evaluator). Add 3 `aide-<scope>.json` deprecation stubs preserving the old UIDs. Add `ops/grafana/README.md` (bilingual zh-TW + EN) + `ops/grafana/provisioning/dashboards.yaml`. Pure config + docs; zero runtime touch.

**Tech Stack:** Grafana dashboard JSON, Grafana provisioning YAML, Markdown, bash for verification gates.

**Spec reference:** `docs/superpowers/specs/2026-05-12-grafana-observability-pack-design.md` (committed on this branch as `1d32704`, corrected by `76f9f9a`).

**Branch state:** On `refactor/124-grafana-observability-pack`, branched from main `f39e54c`. Spec doc is the only content so far.

---

## Task 1: Scaffold directory + git-rename dashboards

**Files:**
- Create: `ops/grafana/provisioning/` (directory)
- Rename: `ops/grafana/body-capture.json` → `ops/grafana/caliber-body-capture.json`
- Rename: `ops/grafana/evaluator.json` → `ops/grafana/caliber-evaluator.json`
- Rename: `ops/grafana/gdpr.json` → `ops/grafana/caliber-gdpr.json`

- [ ] **Step 1: Create the provisioning subdirectory**

```bash
mkdir -p ops/grafana/provisioning
```

- [ ] **Step 2: Git-rename the three dashboards**

```bash
git mv ops/grafana/body-capture.json ops/grafana/caliber-body-capture.json
git mv ops/grafana/evaluator.json ops/grafana/caliber-evaluator.json
git mv ops/grafana/gdpr.json ops/grafana/caliber-gdpr.json
```

`git mv` preserves history; do NOT edit content in this commit, otherwise the rename detection threshold (50%) may flip to delete+add and history is lost.

- [ ] **Step 3: Sanity check**

```bash
ls ops/grafana/
git status --short
```
Expected:
- `ls` shows `caliber-body-capture.json`, `caliber-evaluator.json`, `caliber-gdpr.json`, `provisioning/` (and any existing files like `README.md` if present from prior phases — but on this branch there's no README yet)
- `git status --short` shows three `R` (rename) lines

- [ ] **Step 4: Commit**

```bash
git add ops/grafana/
git commit -m "refactor(ops): rename Grafana dashboards aide → caliber via git mv (#124)

Pure rename so subsequent in-place edits preserve git blame across
the aide → Caliber rebrand. Contents unchanged in this commit; UID,
title, tags, datasource templating, and folder pinning are applied
file-by-file in the next three commits."
```

---

## Task 2: Rewrite caliber-body-capture.json

**Files:**
- Modify: `ops/grafana/caliber-body-capture.json`

Applies 6 of the 8 JSON change rules (per spec). Skips rule 7 (org_id var — none of the body-capture metrics carry that label).

- [ ] **Step 1: Inspect current state**

```bash
grep -nE '"uid"|"title"|"tags"|"folderUid"' ops/grafana/caliber-body-capture.json
grep -c '"uid": "prometheus"' ops/grafana/caliber-body-capture.json
```
Expected:
- `uid` value is currently `aide-body-capture`
- `title` value is currently `AIDE — Body Capture`
- `tags` value is currently `["aide", "body-capture", "plan-4c"]`
- No `folderUid` line
- ~5 occurrences of hardcoded `"uid": "prometheus"` in panel datasource refs

- [ ] **Step 2: Replace UID (Edit tool)**

`old_string`: `"uid": "aide-body-capture",`
`new_string`: `"uid": "caliber-body-capture",`

- [ ] **Step 3: Replace title**

`old_string`: `"title": "AIDE — Body Capture",`
`new_string`: `"title": "Caliber — Body Capture",`

- [ ] **Step 4: Replace tags**

`old_string`: `"tags": ["aide", "body-capture", "plan-4c"],`
`new_string`: `"tags": ["caliber", "gateway", "body-capture"],`

- [ ] **Step 5: Add folderUid + folderTitle right after `tags`**

Use Edit to expand the tags line:

`old_string`:
```
  "tags": ["caliber", "gateway", "body-capture"],
```

`new_string`:
```
  "tags": ["caliber", "gateway", "body-capture"],
  "folderUid": "caliber",
  "folderTitle": "Caliber",
```

- [ ] **Step 6: Replace all hardcoded datasource UIDs**

Use sed (BSD on macOS):
```bash
sed -i '' 's|"uid": "prometheus"|"uid": "${datasource}"|g' ops/grafana/caliber-body-capture.json
```

Verify:
```bash
grep -c '"uid": "prometheus"' ops/grafana/caliber-body-capture.json
# Expected: 0
grep -c '"uid": "${datasource}"' ops/grafana/caliber-body-capture.json
# Expected: previously the same number of panel datasource refs (~5+)
```

- [ ] **Step 7: Add the `datasource` template variable**

Locate the `"templating"` block (likely empty `{"list": []}` currently). Use Edit:

`old_string`:
```
  "templating": { "list": [] },
```

`new_string`:
```
  "templating": {
    "list": [
      {
        "name": "datasource",
        "label": "Data source",
        "type": "datasource",
        "query": "prometheus",
        "current": { "selected": false, "text": "default", "value": "default" },
        "hide": 0,
        "refresh": 1,
        "regex": "",
        "skipUrlSync": false
      }
    ]
  },
```

If the existing `templating` block is multi-line or otherwise differs, adapt the `old_string` to match exactly. Read the file around the templating block first.

- [ ] **Step 8: Bump `version` field from 1 to 2**

`old_string`: `"version": 1,`
`new_string`: `"version": 2,`

- [ ] **Step 9: JSON validity check**

```bash
python3 -c "import json; d=json.load(open('ops/grafana/caliber-body-capture.json')); print('OK:', d['uid'], '|', d['title'], '|', d['tags'])"
```
Expected: `OK: caliber-body-capture | Caliber — Body Capture | ['caliber', 'gateway', 'body-capture']`

- [ ] **Step 10: Commit**

```bash
git add ops/grafana/caliber-body-capture.json
git commit -m "refactor(ops): rewrite caliber-body-capture for portability (#124)

- UID aide-body-capture → caliber-body-capture
- Title AIDE → Caliber
- Tags drop plan-4c internal milestone, add gateway scope
- folderUid: caliber for provisioning grouping
- Datasource UIDs templated as \${datasource} so operators with
  non-default Prometheus datasource UIDs can import without editing
- Version bumped to 2

No org_id template variable because none of the gw_body_* metrics
carry org_id (verified against apps/gateway/src/plugins/metrics.ts)."
```

---

## Task 3: Rewrite caliber-evaluator.json

**Files:**
- Modify: `ops/grafana/caliber-evaluator.json`

This dashboard already has an `org_id` template variable. Three of its panels (facet-related) need `{org_id=~"$org_id"}` filters added; the cost panels already filter via `sum by (org_id)`.

- [ ] **Step 1: Inspect current state**

```bash
grep -nE '"uid"|"title"|"tags"|"folderUid"|"name": "org_id"' ops/grafana/caliber-evaluator.json
```

- [ ] **Step 2: Replace UID, title, tags (3 Edit calls)**

| old_string | new_string |
|---|---|
| `"uid": "aide-evaluator",` | `"uid": "caliber-evaluator",` |
| `"title": "AIDE — Evaluator",` | `"title": "Caliber — Evaluator",` |
| `"tags": ["aide", "evaluator", "plan-4c"],` | `"tags": ["caliber", "gateway", "evaluator"],` |

(If the existing tags array differs slightly — e.g. `"plan-4b"` instead — read the file to see exact value, and substitute the same shape with the canonical new value.)

- [ ] **Step 3: Add folderUid + folderTitle (same pattern as Task 2 Step 5)**

`old_string`:
```
  "tags": ["caliber", "gateway", "evaluator"],
```

`new_string`:
```
  "tags": ["caliber", "gateway", "evaluator"],
  "folderUid": "caliber",
  "folderTitle": "Caliber",
```

- [ ] **Step 4: Replace all hardcoded datasource UIDs**

```bash
sed -i '' 's|"uid": "prometheus"|"uid": "${datasource}"|g' ops/grafana/caliber-evaluator.json
```

Verify the `org_id` template variable was correctly rewritten (its `datasource` field should now also be `${datasource}`):
```bash
grep -A2 '"name": "org_id"' ops/grafana/caliber-evaluator.json | head -5
```
Expected: shows `"datasource": { "type": "prometheus", "uid": "${datasource}" }`.

- [ ] **Step 5: Prepend the `datasource` template variable to `templating.list`**

`old_string`:
```
  "templating": {
    "list": [
      {
        "name": "org_id",
```

`new_string`:
```
  "templating": {
    "list": [
      {
        "name": "datasource",
        "label": "Data source",
        "type": "datasource",
        "query": "prometheus",
        "current": { "selected": false, "text": "default", "value": "default" },
        "hide": 0,
        "refresh": 1,
        "regex": "",
        "skipUrlSync": false
      },
      {
        "name": "org_id",
```

This inserts the new variable before the existing `org_id`. Both end up in `templating.list[]`.

- [ ] **Step 6: Add `{org_id=~"$org_id"}` filter to the 3 facet panels**

The 3 panels with metrics that carry `org_id` and currently lack the filter:

| Panel | old expr | new expr |
|---|---|---|
| Facet extraction by result | `sum by (result) (rate(gw_facet_extract_total[5m]))` | `sum by (result) (rate(gw_facet_extract_total{org_id=~"$org_id"}[5m]))` |
| Facet duration heatmap | `sum by (le) (rate(gw_facet_extract_duration_ms_bucket[5m]))` | `sum by (le) (rate(gw_facet_extract_duration_ms_bucket{org_id=~"$org_id"}[5m]))` |
| Facet cache hit rate (hit term) | `sum(rate(gw_facet_cache_hit_total{result="hit"}[5m]))` | `sum(rate(gw_facet_cache_hit_total{result="hit",org_id=~"$org_id"}[5m]))` |
| Facet cache hit rate (total term) | `sum(rate(gw_facet_cache_hit_total[5m]))` | `sum(rate(gw_facet_cache_hit_total{org_id=~"$org_id"}[5m]))` |

Before each Edit, read the actual expr in the file — the exact metric suffix may differ (e.g. `_bucket` vs no suffix; histogram metrics have `_bucket` added by prom-client automatically). Adapt `old_string` to match the literal file content.

If a panel uses a different expr shape than shown above (e.g. `clamp_min(...)` wrapping), preserve the outer wrapper and only modify the inner metric selector.

- [ ] **Step 7: Bump `version` field from 1 to 2**

`old_string`: `"version": 1,`
`new_string`: `"version": 2,`

- [ ] **Step 8: JSON validity check**

```bash
python3 -c "import json; d=json.load(open('ops/grafana/caliber-evaluator.json')); print('OK:', d['uid'], '|', d['title'], '|', d['tags'], '|', [v['name'] for v in d['templating']['list']])"
```
Expected: `OK: caliber-evaluator | Caliber — Evaluator | ['caliber', 'gateway', 'evaluator'] | ['datasource', 'org_id']`

- [ ] **Step 9: Commit**

```bash
git add ops/grafana/caliber-evaluator.json
git commit -m "refactor(ops): rewrite caliber-evaluator for portability (#124)

- UID, title, tag taxonomy (drop plan-4c)
- folderUid + folderTitle for provisioning
- Prepend \${datasource} template variable; rewire all panel
  datasource refs (including the existing org_id variable's own
  datasource field)
- Apply {org_id=~\"\$org_id\"} filter to the 3 facet panels whose
  metrics (gw_facet_extract_total, gw_facet_extract_duration_ms,
  gw_facet_cache_hit_total) carry the label
- Cost panels already filter via 'sum by (org_id)'; preserved
- Other eval panels (job rate, parse fail, DLQ, cost gauge) use
  metrics without org_id label; not filtered
- Version bumped to 2"
```

---

## Task 4: Rewrite caliber-gdpr.json

**Files:**
- Modify: `ops/grafana/caliber-gdpr.json`

Same shape as Task 2 (no org_id filter — none of the `gw_gdpr_*` metrics carry the label).

- [ ] **Step 1: Inspect current state**

```bash
grep -nE '"uid"|"title"|"tags"|"folderUid"' ops/grafana/caliber-gdpr.json
grep -c '"uid": "prometheus"' ops/grafana/caliber-gdpr.json
```

- [ ] **Step 2–8: Apply Task 2 Steps 2–8 verbatim, substituting `gdpr` everywhere**

| Substitution | Value |
|---|---|
| UID old / new | `aide-gdpr` → `caliber-gdpr` |
| Title old / new | `AIDE — GDPR` → `Caliber — GDPR` |
| Tags old / new | `["aide", "gdpr", "plan-4c"]` → `["caliber", "gateway", "gdpr"]` |
| sed datasource | identical command, file path changes to `ops/grafana/caliber-gdpr.json` |
| Templating block | identical block insertion |
| version bump | identical |

- [ ] **Step 9: JSON validity check**

```bash
python3 -c "import json; d=json.load(open('ops/grafana/caliber-gdpr.json')); print('OK:', d['uid'], '|', d['title'], '|', d['tags'])"
```
Expected: `OK: caliber-gdpr | Caliber — GDPR | ['caliber', 'gateway', 'gdpr']`

- [ ] **Step 10: Commit**

```bash
git add ops/grafana/caliber-gdpr.json
git commit -m "refactor(ops): rewrite caliber-gdpr for portability (#124)

Same rebrand pattern as caliber-body-capture: UID, title, tag
taxonomy, folderUid, datasource templating, version bump. No org_id
template variable because gw_gdpr_* metrics do not carry the label."
```

---

## Task 5: Create three aide-* deprecation stubs

**Files:**
- Create: `ops/grafana/aide-body-capture.json`
- Create: `ops/grafana/aide-evaluator.json`
- Create: `ops/grafana/aide-gdpr.json`

Each is a one-panel markdown stub that preserves the old UID and redirects to the matching `caliber-*` dashboard.

- [ ] **Step 1: Write `aide-body-capture.json`**

```json
{
  "annotations": { "list": [] },
  "editable": false,
  "graphTooltip": 0,
  "panels": [
    {
      "id": 1,
      "type": "text",
      "title": "",
      "gridPos": { "h": 12, "w": 24, "x": 0, "y": 0 },
      "options": {
        "mode": "markdown",
        "content": "# This dashboard has moved\n\nThe `aide-*` dashboards are deprecated as part of the aide → Caliber rebrand.\n\n**Open the new dashboard:** [Caliber — Body Capture](/d/caliber-body-capture)\n\nThis redirect will be removed in a future cleanup PR once operators have migrated their bookmarks."
      }
    }
  ],
  "refresh": "",
  "schemaVersion": 39,
  "tags": ["aide", "deprecated"],
  "templating": { "list": [] },
  "time": { "from": "now-6h", "to": "now" },
  "timepicker": {},
  "timezone": "utc",
  "title": "AIDE — Body Capture (deprecated, see /d/caliber-body-capture)",
  "uid": "aide-body-capture",
  "version": 2,
  "weekStart": ""
}
```

- [ ] **Step 2: Write `aide-evaluator.json`**

Same template, with these substitutions:
- `content` link target: `/d/caliber-evaluator`
- `content` link text: `Caliber — Evaluator`
- `title`: `AIDE — Evaluator (deprecated, see /d/caliber-evaluator)`
- `uid`: `aide-evaluator`

- [ ] **Step 3: Write `aide-gdpr.json`**

Same template, substitutions:
- link target: `/d/caliber-gdpr`
- link text: `Caliber — GDPR`
- `title`: `AIDE — GDPR (deprecated, see /d/caliber-gdpr)`
- `uid`: `aide-gdpr`

- [ ] **Step 4: JSON validity check**

```bash
for f in ops/grafana/aide-*.json; do
  python3 -c "import json; d=json.load(open('$f')); print('$f:', d['uid'], '|', len(d['panels']), 'panels')"
done
```
Expected: each line shows `1 panels`. UIDs match filenames.

- [ ] **Step 5: Commit**

```bash
git add ops/grafana/aide-body-capture.json ops/grafana/aide-evaluator.json ops/grafana/aide-gdpr.json
git commit -m "feat(ops): aide-* Grafana deprecation stubs (#124)

Preserve the old aide-body-capture, aide-evaluator, aide-gdpr UIDs
as one-panel markdown stubs that redirect to the matching caliber-*
dashboard. Existing operator bookmarks pointing at /d/aide-* no
longer 404 — they open a 'moved to' panel with a one-click link.

editable: false prevents accidental edits to the stubs. Tracked for
removal in the Phase 4c follow-up issue (T+30d)."
```

---

## Task 6: Provisioning manifest

**Files:**
- Create: `ops/grafana/provisioning/dashboards.yaml`

- [ ] **Step 1: Write the file**

```yaml
# Grafana dashboard provisioning manifest for the Caliber Observability Pack.
# Mount this at /etc/grafana/provisioning/dashboards/caliber.yaml and the JSON
# dashboards at /etc/grafana/provisioning/dashboards/caliber/.
# See ../README.md for full setup.

apiVersion: 1

providers:
  - name: caliber
    orgId: 1
    folder: Caliber
    folderUid: caliber
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards/caliber
      foldersFromFilesStructure: false
```

- [ ] **Step 2: YAML validity check**

```bash
python3 -c "import yaml; d=yaml.safe_load(open('ops/grafana/provisioning/dashboards.yaml')); assert d['apiVersion']==1 and d['providers'][0]['folderUid']=='caliber'; print('YAML OK')"
```
Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add ops/grafana/provisioning/dashboards.yaml
git commit -m "feat(ops): Grafana provisioning manifest for Caliber pack (#124)

Standard Grafana file-provider config. Mount the manifest +
ops/grafana/ directory into the Grafana container's
/etc/grafana/provisioning/dashboards path and restart — Grafana
auto-creates the Caliber folder and imports all 6 dashboards (3
caliber-* full + 3 aide-* deprecation stubs).

allowUiUpdates: true lets operators tweak dashboards in the UI
without provisioner overwriting at the next reload.
disableDeletion: false lets git rm of a JSON file propagate to
dashboard removal — needed for the Phase 4c stub cleanup."
```

---

## Task 7: README (bilingual zh-TW + EN)

**Files:**
- Create: `ops/grafana/README.md`

- [ ] **Step 1: Write the file content**

Create `ops/grafana/README.md` with the following content (paste verbatim — bilingual, EN first per spec; tables and code blocks are EN-canonical with bilingual prose):

```markdown
# Caliber Observability Pack / Caliber 可觀測性套件

Prometheus + Grafana dashboards for the Caliber gateway. Drop into your Grafana provisioning directory and get instant insight into request capture, evaluator behavior, and GDPR / retention.

Caliber gateway 的 Prometheus + Grafana 儀表板。放到 Grafana provisioning 目錄即可立即觀察請求擷取、評核器、GDPR / 保留期限等狀態。

## What's in here / 內含

| Dashboard | UID | What it shows / 顯示內容 |
|---|---|---|
| Caliber — Body Capture | `caliber-body-capture` | Request capture rate, retention purge lag, purge tick duration / 請求擷取速率、保留期限清理延遲、清理週期耗時 |
| Caliber — Evaluator | `caliber-evaluator` | Rule-based + facet evaluation, DLQ depth, LLM cost per org / 規則評核與面向擷取、DLQ 深度、各組織 LLM 成本 |
| Caliber — GDPR | `caliber-gdpr` | Delete executions, auto-rejections, failure rate / 刪除執行、自動拒絕、失敗率 |

The three `aide-*.json` files are deprecation stubs from the aide → Caliber rebrand — see the "Migration" section below.

`aide-*.json` 是 aide → Caliber 改名遺留的 deprecation stub，見下方 Migration 段。

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

A `Caliber` folder appears containing all 6 dashboards (3 caliber-* + 3 aide-* stubs).

會出現 `Caliber` 資料夾，內含 6 個 dashboard（3 個 caliber-* + 3 個 aide-* stub）。

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
- `gw_eval_llm_cost_usd_total` — cumulative evaluator cost counter
- `gw_facet_extract_total{org_id, result}` — facet extraction counter
- `gw_facet_extract_duration_ms_bucket{org_id}` — facet duration histogram
- `gw_facet_cache_hit_total{org_id, result}` — facet cache hit/miss
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
| Evaluator LLM cost (USD/hour) | `sum(rate(gw_eval_llm_cost_usd_total[1h])) * 3600` |
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

## Migration: aide → Caliber

The three `aide-*.json` files preserve the old UIDs (`aide-body-capture`, `aide-evaluator`, `aide-gdpr`) as one-panel deprecation stubs. Opening one shows a "moved to" message linking to the new dashboard, so existing operator bookmarks pointing at `/d/aide-*` do not 404.

The stubs will be removed in a future cleanup PR once operators have migrated their bookmarks.

`aide-*.json` 三個檔案保留舊 UID（`aide-body-capture` / `aide-evaluator` / `aide-gdpr`），為單面板的 deprecation stub。書籤連到舊 URL 不會 404，會看到「已遷移」提示與新 dashboard 連結。

待 operator 遷移完書籤後，會於後續清理 PR 移除這些 stub。

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
```

- [ ] **Step 2: Bilingual sanity check**

```bash
grep -c "安裝" ops/grafana/README.md
grep -c "Install" ops/grafana/README.md
```
Both should be ≥ 2.

- [ ] **Step 3: Commit**

```bash
git add ops/grafana/README.md
git commit -m "docs(ops): Caliber Observability Pack bilingual README (#124)

EN-first, zh-TW immediately following. Sections: what's in here,
prerequisites, two install methods (provisioning vs UI import),
required metrics, panel ↔ metric mapping (3 tables), customization,
aide → Caliber migration note, versioning, contributing, license."
```

---

## Task 8: Verification gates

**Files:** none modified (verification only)

- [ ] **Step 1: Run all 10 verification gates from the spec**

Paste this block into a shell from repo root. Every assert that succeeds prints `OK`; the first failure halts.

```bash
set -e

# 1. JSON valid on all 6 dashboard files
for f in ops/grafana/{aide,caliber}-*.json; do
  python3 -c "import json; json.load(open('$f'))" && echo "$f JSON OK"
done

# 2. UID matches filename
for f in ops/grafana/{aide,caliber}-*.json; do
  uid=$(python3 -c "import json; print(json.load(open('$f'))['uid'])")
  base=$(basename "$f" .json)
  [ "$uid" = "$base" ] && echo "$f UID OK" || { echo "$f UID MISMATCH: $uid"; exit 1; }
done

# 3. caliber-* dashboards have folderUid: caliber
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert d.get('folderUid')=='caliber', '$f missing folderUid'" && echo "$f folderUid OK"
done

# 4. Tag taxonomy
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert 'caliber' in d['tags'] and 'gateway' in d['tags'], '$f tags wrong'" && echo "$f tags OK"
done

# 5. datasource template variable present
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); vars=[v['name'] for v in d['templating']['list']]; assert 'datasource' in vars, '$f missing datasource var'" && echo "$f datasource var OK"
done

# 6. No hardcoded "uid": "prometheus" left in caliber-*
for f in ops/grafana/caliber-*.json; do
  if grep -q '"uid": "prometheus"' "$f"; then
    echo "$f FAIL: hardcoded datasource"; exit 1
  else
    echo "$f no hardcoded datasource OK"
  fi
done

# 7. provisioning YAML parses
python3 -c "import yaml; d=yaml.safe_load(open('ops/grafana/provisioning/dashboards.yaml')); assert d['providers'][0]['folderUid']=='caliber'" && echo "provisioning YAML OK"

# 8. aide stubs have exactly 1 panel of type text
for f in ops/grafana/aide-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert len(d['panels'])==1 and d['panels'][0]['type']=='text', '$f stub shape wrong'" && echo "$f stub shape OK"
done

# 9. aide stubs reference matching caliber UID
for stub in body-capture evaluator gdpr; do
  if grep -q "/d/caliber-$stub" "ops/grafana/aide-$stub.json"; then
    echo "aide-$stub.json caliber link OK"
  else
    echo "aide-$stub.json MISSING caliber redirect"; exit 1
  fi
done

# 10. README bilingual sanity
grep -q "^## Install" ops/grafana/README.md && grep -q "安裝" ops/grafana/README.md && echo "README bilingual OK"

echo "ALL 10 GATES PASSED"
```

Expected last line: `ALL 10 GATES PASSED`.

- [ ] **Step 2: No commit** (verification only). Move to Task 9.

---

## Task 9: Open Phase 4c follow-up issue

**Files:** none.

- [ ] **Step 1: Open the issue**

```bash
gh issue create --repo hanfour/aide \
  --title "Phase 4c cleanup: drop Grafana aide-* deprecation stubs" \
  --label rebrand --label cleanup \
  --body "$(cat <<'EOF'
Deferred cleanup from #124. Blocked by T+30 days from the merge date of the #124 PR, OR explicit operator confirmation that bookmarks have been migrated.

## Why deferred

The aide-* Grafana dashboard UIDs were preserved as one-panel deprecation stubs to keep operator bookmarks working through the rebrand. Once bookmarks have migrated, the stubs can be removed.

## Acceptance

- [ ] Delete \`ops/grafana/aide-body-capture.json\`
- [ ] Delete \`ops/grafana/aide-evaluator.json\`
- [ ] Delete \`ops/grafana/aide-gdpr.json\`
- [ ] Remove the \"Migration: aide → Caliber\" section from \`ops/grafana/README.md\`
- [ ] Verify in Grafana that no dashboard or bookmark still references aide-* UIDs

## Source

Tracked in the design doc:
\`docs/superpowers/specs/2026-05-12-grafana-observability-pack-design.md\`
EOF
)"
```

Capture the issue number printed. It goes into the PR body.

- [ ] **Step 2: No commit.** Move to Task 10.

---

## Task 10: Commit plan + push + open PR + watch CI

- [ ] **Step 1: Commit this plan**

```bash
git add docs/superpowers/plans/2026-05-12-grafana-observability-pack.md
git commit -m "docs(plan): implementation plan for Grafana Observability Pack (#124)"
```

- [ ] **Step 2: Sanity check log**

```bash
git log --oneline main..HEAD
```

Expected commits (chronological order):
- spec doc
- spec correction (org_id scope)
- this plan
- Task 1 rename
- Task 2 caliber-body-capture
- Task 3 caliber-evaluator
- Task 4 caliber-gdpr
- Task 5 aide-* stubs
- Task 6 provisioning YAML
- Task 7 README

- [ ] **Step 3: Push branch**

```bash
git push -u origin refactor/124-grafana-observability-pack
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --repo hanfour/aide \
  --base main \
  --head refactor/124-grafana-observability-pack \
  --title "feat: Caliber Observability Pack — Grafana rebrand + portability (#124)" \
  --body "$(cat <<'EOF'
## TL;DR

Closes #124 by re-shipping the 3 Grafana dashboards as a self-contained pack any operator can drop into Grafana via volume mount + restart. Hard rename aide-* → caliber-*; keep aide-* as one-panel deprecation stubs so existing operator bookmarks redirect cleanly.

## Why

Final actionable rebrand backlog item. Designed with open-source / commercialization fit in mind: bilingual README, Grafana datasource templating so non-default Prometheus UIDs work without editing, provisioning manifest for one-step setup, public tag taxonomy.

## What's in

- **3 caliber-* dashboards** (renamed from body-capture.json / evaluator.json / gdpr.json via `git mv` so blame survives):
  - UID, title, tags (drop internal \`plan-4c\` milestone)
  - \`folderUid: caliber\` for provisioning folder grouping
  - \`\${datasource}\` template variable so importers pick their Prometheus instance
  - \`{org_id=~\"\$org_id\"}\` filter on the 3 evaluator facet panels (cost panels already filter via \`sum by (org_id)\`)
- **3 aide-* deprecation stubs**: one markdown panel each linking to the matching caliber-* dashboard, preserving the old UIDs so bookmarks don't 404
- **\`ops/grafana/provisioning/dashboards.yaml\`**: standard Grafana file provider config — mount the manifest + dir, restart Grafana, done
- **\`ops/grafana/README.md\`**: bilingual zh-TW + EN, 12 sections including panel ↔ metric mapping tables and an aide → Caliber migration note
- **Spec + plan**: \`docs/superpowers/specs/\` + \`docs/superpowers/plans/\`

## What's NOT in (filed as follow-up)

- Removal of the 3 aide-* deprecation stubs → tracked in the Phase 4c follow-up issue opened with this PR; blocked on T+30 days from merge.

## Tests

This PR is pure config + docs (no runtime code touched). Verification via 10 offline gates (see plan Task 8):

- JSON valid on all 6 dashboards
- UID matches filename
- folderUid + tag taxonomy on every caliber-*
- datasource templating present
- No hardcoded \`\"uid\": \"prometheus\"\` left
- provisioning YAML parses
- aide stubs are 1-panel text with correct redirect target
- README is bilingual

CI \`lint-type-test\` / \`integration\` / etc. should be green (no source or test code modified).

## Operator upgrade

After merging:

1. Mount the pack into your Grafana container:
   \`\`\`yaml
   grafana:
     volumes:
       - ./ops/grafana:/etc/grafana/provisioning/dashboards/caliber:ro
       - ./ops/grafana/provisioning/dashboards.yaml:/etc/grafana/provisioning/dashboards/caliber.yaml:ro
   \`\`\`
2. \`docker compose restart grafana\`
3. A \`Caliber\` folder appears in Grafana with all 6 dashboards.
4. (Optional) Update personal bookmarks from \`/d/aide-*\` → \`/d/caliber-*\`. The stubs handle the redirect for now.

## Closes

Closes #124.
EOF
)"
```

- [ ] **Step 5: Watch CI**

Capture PR number from previous step output. Then:

```bash
gh pr checks <NN> --repo hanfour/aide --watch
```

Expected: all 6 checks pass. No code touched, so failures are unlikely. If anything fails, inspect with `gh run view <run_id> --log-failed`.

Do NOT merge in this task — user authorizes merge after final review.

---

## Self-review

**Spec coverage:**
- File layout (6 dashboards + README + provisioning) → Tasks 1, 5, 6, 7 ✓
- JSON change rules 1–9 → Tasks 2, 3, 4 ✓
- Deprecation stub template → Task 5 ✓
- README structure + bilingual + Panel ↔ Metric mapping → Task 7 ✓
- Provisioning manifest → Task 6 ✓
- Required metrics list → README (Task 7) ✓
- Operator upgrade path → PR body (Task 10) ✓
- 10 verification gates → Task 8 ✓
- Rollback → covered by revert (no special task)
- Phase 4c follow-up issue → Task 9 ✓

**Placeholder scan:**
- No "TBD" / "implement later" anywhere.
- `<NN>` placeholder in Task 10 Step 5 is the genuine "PR number unknown until `gh pr create` returns" case.

**Type / value consistency:**
- UID naming `aide-<scope>` → `caliber-<scope>` consistent across Tasks 1–5.
- Tag taxonomy `["caliber", "gateway", "<scope>"]` identical in Tasks 2, 3, 4.
- `folderUid: caliber` / `folderTitle: Caliber` identical across the 3 caliber-* dashboards and the provisioning YAML.
- `${datasource}` syntax identical everywhere (Tasks 2 Step 6 / 3 Step 4 / 4 Step uses the same sed pattern).
- Stub redirect link format `/d/caliber-<scope>` consistent (Task 5) and verified by gate #9 (Task 8).
- README's metric tables match Task 3 Step 6's metric names (`gw_facet_extract_duration_ms_bucket`, not `_seconds_bucket`).

**Discrepancy callouts:**
- Spec was corrected before plan was written (`76f9f9a`): `gw_body_*` and `gw_gdpr_*` metrics do not carry `org_id`, so the `org_id` template variable is NOT added to body-capture or gdpr. Tasks 2 and 4 do not include that step. Task 3 (evaluator) does, with the filter scope limited to facet panels.
- Plan does NOT include a smoke-test docker-compose fixture (per user decision during spec review).

