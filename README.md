# Caliber

**Measure the caliber of your AI-assisted engineering.** A self-hostable gateway, audit log, and evaluator for teams that want to know exactly what their AI coding assistants are doing — and how well.

**精準衡量你的 AI 工程力。** 自架的 gateway / 稽核 / 評核平台，讓團隊清楚知道 AI 助理到底在做什麼、做得多好。

---

## Why / 為什麼需要這個工具

Engineering managers need evidence-based data to evaluate how effectively their team uses AI coding assistants. Manual review of hundreds of AI sessions is impractical. This tool automates the process by:

研發經理需要基於證據的資料來評估團隊使用 AI 程式助手的成效。手動審查數百個 AI 工作階段不切實際。本工具透過以下方式自動化此流程：

1. **Extracting** usage data from local Claude Code (`~/.claude/`) and Codex (`~/.codex/`) storage
2. **Analyzing** session patterns for decision-making quality and risk identification
3. **Scoring** against a configurable evaluation standard (default: OneAD R&D standard)
4. **Generating** structured reports with evidence and score recommendations

---

## Features / 功能特色

- Reads Claude Code session metadata, facets, SQLite cost data, and JSONL conversations
- Reads Codex SQLite thread data (tokens, models, sessions)
- Detects decision-making patterns (iterative refinement, multi-task coordination, active corrections)
- Detects risk identification signals (security awareness, performance discussions, bug catching)
- Configurable evaluation standard — bring your own criteria, keywords, and thresholds
- Multiple output formats: terminal (colored), JSON, Markdown, HTML
- JSON output is machine-parseable (`--format json` emits clean JSON to stdout, progress logs go to stderr)
- Noise filtering to exclude system messages and code review templates from analysis
- `init-standard` command to export the default standard as a customization template
- Data quality warnings when data sources are missing or incomplete

---

## Platform mode / 平台模式

Starting with **v0.2.0** Caliber also ships as a self-hostable web platform with
organization-scoped RBAC, invites, and an audit log. Use this mode if you want
a shared workspace for a team rather than a per-engineer CLI report.

**v0.3.0** adds an opt-in **gateway** that proxies Anthropic-native
(`/v1/messages`) and OpenAI-compatible (`/v1/chat/completions`) traffic
through a shared pool of upstream accounts:

- Admins donate `sk-ant-...` API keys or OAuth bundles extracted from Claude
  Code; the gateway's scheduler picks one per request based on priority,
  concurrency, and rate-limit state.
- Each user self-issues or receives an admin-issued platform API key
  (`ak_...`) that authenticates against the gateway.
- Usage + cost (per Anthropic/OpenAI token pricing) lands in a `usage_logs`
  table, surfaced via per-user and per-org dashboards.

**v0.4.0** adds an opt-in **evaluator** subsystem for performance evaluation
(gated behind `ENABLE_EVALUATOR` feature flag):

- **Content capture opt-in** — organization-level toggle; members see their
  captured usage on `/dashboard/profile/evaluation`. 90-day default retention
  (per-org override: 30/60/90). AES-256-GCM encryption with domain-separated
  HKDF keys.
- **Dual-layer evaluation** — rule-based scoring (always-on) + optional LLM
  Deep Analysis (per-org opt-in). Costs dogfooded via self-gateway loopback
  and tracked in `usage_logs`.
- **Admin-customizable scoring rubrics** — platform defaults seeded for
  English, Traditional Chinese, and Japanese; organizations can define custom
  rubrics with dry-run preview. Zod-validated signal discriminated union
  (keywords, thresholds, refusal rates, client mix, model diversity, cache
  patterns, extended thinking, tool variety, iteration counts) — **extended
  in v0.5.0** with six facet-based signal types.
- **GDPR member-initiated delete request workflow** — members request deletion,
  org admins approve (or auto-reject after 30 days). Retention purge and GDPR
  execution run on separate cron workers.
- **Labor-law-friendly transparency** — members see their own scores plus a
  growth-oriented user report; org admins receive a separate, deeper report
  with evidence-linked concerns, coaching guidance, calibration notes, and
  data limitations. Audience selection happens server-side. Team managers see
  redacted team views unless they are also org admins. Leaderboard visibility
  is opt-in per organization (privacy default).

**v0.5.0** extends the v0.4.0 evaluator with **per-org LLM cost budgeting**
and **opt-in LLM facet extraction** (gated behind `ENABLE_FACET_EXTRACTION`
env + per-org `llm_facet_enabled`). All v0.4.0 behaviour preserved when both
flags are off.

- **Cost budget infrastructure** — every org gets `llm_monthly_budget_usd`
  + `llm_budget_overage_behavior` (`degrade` skips over-budget calls,
  `halt` stops all LLM until next UTC month). Spend tracked per-call in a
  new `llm_usage_events` ledger, summed per UTC month, enforced before each
  LLM call. Cost dashboard at `/dashboard/organizations/<id>/evaluator/costs`
  with breakdowns by task / model / 6-month history; compact widget on the
  evaluator status page.
- **LLM facet extraction** — opt-in second LLM pass per session that
  classifies each evaluation window's sessions into structured JSON
  (`{sessionType, outcome, claudeHelpfulness, frictionCount, bugsCaughtCount,
  codexErrorsCount}`). Extracted rows persisted to `request_body_facets`
  table with `prompt_version` cache so the same LLM call doesn't fire twice.
  Deterministic failures (parse / validation / timeout) write an error row
  so they don't retry; transient failures (5xx, budget hit) skip silently.
- **Six new rubric signal types** consume the facet aggregate:
  `facet_claude_helpfulness`, `facet_friction_per_session`,
  `facet_bugs_caught`, `facet_codex_errors`, `facet_outcome_success_rate`,
  `facet_session_type_ratio`. Custom rubrics can opt in today; the rubric
  editor ships an in-form Signal types reference.
- **Platform default rubrics bumped to v1.1.0** — strictly additive: each
  section gains one facet support (`facet_outcome_success` to `interaction`,
  `facet_bugs_caught` to `riskControl`). Orgs without facet extraction see
  zero scoring change.
- **Report-page facet drill-down** — when facet rows exist for the period,
  the user's evaluation report shows session-type distribution, success
  rate, avg helpfulness, and bug/friction/codex counters. Hidden silently
  when no rows exist.
- **Observability artifacts** shipped under `ops/`: 3 Grafana dashboards
  (evaluator / body-capture / GDPR), 11 Prometheus alert rules, 9 runbooks
  in `docs/runbooks/`, and a post-release smoke workflow that auto-creates a
  `release-blocker` issue when the canary fails.

See [`docs/UPGRADE-v0.5.0.md`](docs/UPGRADE-v0.5.0.md) for the upgrade
playbook (migrations 0004-0007, env flags, three-tier rollback).

Quick start:
```sh
cd docker
cp .env.example .env   # fill in OAuth + bootstrap email (+ gateway secrets if enabling)
docker compose up -d                      # api + web + postgres + redis
docker compose --profile gateway up -d    # opt-in: add gateway service
```

Images are published on every `v*` tag to:

| Image | amd64 | arm64 |
|-------|-------|-------|
| `ghcr.io/hanfour/caliber-api` | ✅ | ✅ |
| `ghcr.io/hanfour/caliber-gateway` (new in v0.3.0) | ✅ | ✅ |
| `ghcr.io/hanfour/caliber-web` | ✅ | ❌ (dropped in v0.5.0; QEMU cross-build was unstable) |

Operator guides:

- **Try locally first**: [`docs/LOCAL_DEPLOY.md`](docs/LOCAL_DEPLOY.md) — 5-min path on your laptop, escalates to on-prem production
- Self-hosting bring-up (api + web + gateway): [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)
- Gateway operator + user reference: [`docs/GATEWAY.md`](docs/GATEWAY.md)

**Cloud deploy templates** (alternatives to docker-compose self-hosting):

- [Render Blueprint](deploy/render/README.md) — closest thing to one-click; provisions Postgres + 3 services; needs Upstash Redis externally
- [Fly.io](deploy/fly/README.md) — three apps + Fly Postgres + Upstash; geographically distributed if you want
- [Railway](deploy/railway/README.md) — native Postgres + Redis plugins; manual service creation per the README

⚠️ Vercel is **not supported** — the gateway is a long-running Fastify
server with BullMQ workers, doesn't fit Vercel's serverless model. See
the deploy/ READMEs for what does work.

Local report commands can still run independently. After `caliber login`, an
org admin can also use the platform's uploaded resident-agent telemetry with
`caliber admin report`; authorization and data retrieval happen through the
platform, while rubric scoring and report generation run in the admin's CLI.

> **First time trying platform mode?** Start with
> [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — a 30-minute
> end-to-end walkthrough that takes a fresh checkout to a working
> personal AI gateway sharing your Claude.ai Pro/Max subscription
> across all your devices.

---

## Data Sources / 資料來源

| Source | Path | Data |
|--------|------|------|
| Claude Code Session Meta | `~/.claude/usage-data/session-meta/*.json` | Tokens, duration, tools, languages, git commits, first prompt |
| Claude Code Facets | `~/.claude/usage-data/facets/*.json` | AI-generated session analysis: goals, outcomes, friction, helpfulness |
| Claude Code SQLite | `~/.claude/__store.db` | Per-message cost (USD), model, duration |
| Claude Code JSONL | `~/.claude/projects/*/*.jsonl` | Full conversation content for keyword signal scanning |
| Codex SQLite | `~/.codex/state_5.sqlite` | Threads: tokens_used, model, title, git info |
| Codex History | `~/.codex/history.jsonl` | Full user prompts by thread/session |
| Codex Logs | `~/.codex/logs_2.sqlite` | Thread-level tool calls and error events |

The local `report`, `summary`, `monthly`, and `quarterly` commands read these
sources **locally and read-only**. `caliber admin report` is the explicit
exception: it securely fetches an authorized member bundle from the configured
Caliber server, then scores it locally.

一般本機報告指令皆為**本地端唯讀存取**。`caliber admin report` 會明確地從已登入的
Caliber server 取得經授權的成員資料，再於管理員本機完成評分。

---

## Prerequisites / 系統需求

- **Node.js** >= 20
- **npm** (included with Node.js)
- `~/.claude/` directory (from Claude Code usage)
- `~/.codex/` directory (from Codex CLI usage, optional)

---

## Installation / 安裝

### Recommended: Install from npm / 建議：從 npm 安裝

```bash
npm install -g @hanfour.huang/caliber

# Verify installation
caliber --version
```

### Update / 更新

```bash
npm install -g @hanfour.huang/caliber@latest
```

Caliber uses `~/.caliber.json` for CLI settings. On first run after upgrading
from the older `aide` CLI, an existing `~/.aide.json` file is read, migrated to
`~/.caliber.json`, and reported with a one-time deprecation notice.

### Existing local-clone users / 已使用 clone 安裝的使用者

If you previously installed from a cloned repo or `npm link`, migrate to the npm package:

```bash
npm unlink -g aide 2>/dev/null || npm uninstall -g @hanfour.huang/aide
npm install -g @hanfour.huang/caliber@latest
```

### Development mode / 開發模式

```bash
git clone https://github.com/hanfour/caliber.git ~/caliber
cd ~/caliber
npm install
npx tsx src/cli.ts --help
```

---

## Quick Start / 快速開始

```bash
# Quick usage summary (last 7 days)
caliber summary

# Full evaluation report (last 30 days, terminal output)
caliber report

# Save report as Markdown
caliber report --format markdown --output report.md

# Save report as HTML
caliber report --format html --output report.html

# Monthly KPI report
caliber monthly
```

---

## Usage / 使用方式

### Quick Summary / 快速摘要

```bash
# Last 7 days (default)
caliber summary

# Custom date range
caliber summary --since 2026-03-01 --until 2026-03-31
```

Output:

```
AI Dev Usage Summary
Period: 2026-03-01 ~ 2026-03-31

Claude Code
  Sessions:    57
  Tokens:      259,336
  Duration:    15676 min
  Active Days: 9

Codex
  Sessions:    1
  Tokens:      368,930
  Active Days: 1
```

### Full Evaluation Report / 完整評核報告

```bash
# Default: last 30 days, text format, built-in OneAD standard
caliber report

# Current calendar month
caliber monthly

# Previous full calendar month
caliber monthly --previous

# Current calendar quarter
caliber quarterly

# Previous full calendar quarter
caliber quarterly --previous

# Custom date range
caliber report --since 2026-03-01 --until 2026-04-14

# Output as Markdown file
caliber report --format markdown --output report.md

# Output as HTML file
caliber report --format html --output report.html

# Output as JSON (machine-parseable, clean stdout)
caliber report --format json --output report.json

# Pipe JSON for programmatic consumption
caliber report --format json 2>/dev/null | jq '.sections[].score'

# Use a custom evaluation standard
caliber report --standard my-standard.json

# Include engineer/department metadata in report
caliber report --engineer "Jane Doe" --department "R&D"
```

> **Note:** When using `--format json`, progress and status messages are written to stderr.
> stdout contains only the JSON report, making it safe to pipe to `jq` or other tools.

### Using the compiled CLI / 使用編譯後的 CLI

If you are developing locally and have run `npm run build`, you can use `node dist/cli.js`:

```bash
node dist/cli.js report --since 2026-03-01 --until 2026-03-31
node dist/cli.js summary
node dist/cli.js monthly --previous --format markdown --output march.md
node dist/cli.js report --format html --output report.html
```

---

## CLI Reference / 命令參考

### `caliber admin report`

Fetch the latest telemetry already uploaded by a connected member agent,
apply the organization's active rubric locally, and generate an admin-depth
Markdown or JSON report. The caller needs `report.read_org`; permission is
checked live on every request. Run `caliber login --server <url>` once to
authorize this CLI in the browser.

```bash
caliber admin report \
  --org onead \
  --member engineer@example.com \
  --since 2026-07-01 \
  --until 2026-07-12 \
  --format markdown \
  --output engineer-report.md
```

The date range is limited to 31 days. Reports reflect events uploaded before
the fetch time; the resident agent's normal polling interval determines the
small delay from an active session. Output files are written with mode `0600`.

### `caliber report`

Generate a full evaluation report.

```
Options:
  -s, --since <date>       Start date, YYYY-MM-DD (default: 30 days ago)
  -u, --until <date>       End date, YYYY-MM-DD (default: today)
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --engineer <name>        Engineer name for report identification
  --department <name>      Department name for report identification
```

### `caliber summary`

Quick usage summary for a date range.

```
Options:
  -s, --since <date>       Start date, YYYY-MM-DD (default: 7 days ago)
  -u, --until <date>       End date, YYYY-MM-DD (default: today)
```

### `caliber monthly`

Generate a monthly KPI report.

```
Options:
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --previous               Use the previous full calendar month
```

### `caliber quarterly`

Generate a quarterly KPI report.

```
Options:
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --previous               Use the previous full calendar quarter
```

### `caliber init-standard`

Export the default evaluation standard as a JSON template for customization.

```
Options:
  -o, --output <file>      Output file path (default: eval-standard.json)
```

---

## Report Structure / 報告結構

The generated report contains the following sections:

### 1. Management Summary / 管理摘要

Management-facing overview for monthly/quarterly KPI review:

- Overall headline
- Period assessment
- Key observations
- Recommended follow-up actions

### 2. Usage Overview / 使用概覽

Quantitative metrics for both Claude Code and Codex:

- Total sessions, tokens (input/output), estimated cost
- Active days, duration
- Top projects by token usage
- Top tools used (Bash, Read, Edit, etc.)
- Model breakdown

### 3-N. Evaluation Sections / 評核區段

Each section defined in the evaluation standard generates:

- **Summary** — aggregate statistics
- **Usage evidence** — workload/depth indicators such as sessions, tool usage, follow-up prompts
- **Score evidence** — threshold-relevant evidence used for 100% / 120% scoring
- **Evidence signals** — grouped by type (iterative refinement, bugs caught, security awareness, etc.)
- **Metrics** — numeric indicators used for scoring

### Final. Score Recommendation / 分值建議

For each evaluation section:

- **Score**: Standard (100%) or Superior (120%)
- **Label**: Human-readable grade
- **Reason**: Evidence-backed explanation referencing the criteria

### Data Quality Warnings / 資料品質警告

The report includes data quality warnings when:

- Required data sources (`~/.claude/usage-data/session-meta`) are missing
- Sessions exist but no facets are found (qualitative analysis limited)
- No keyword signals detected (JSONL files may be missing)
- No sessions found at all in the evaluation period

---

## Custom Evaluation Standards / 自訂評核標準

The built-in default is the OneAD R&D AI-Application Evaluation Standard. To create your own:

### Step 1: Export the default template / 匯出預設範本

```bash
npx tsx src/cli.ts init-standard --output my-standard.json
```

### Step 2: Edit the JSON file / 編輯 JSON 檔案

Key fields you can customize:

| Field | Purpose |
|-------|---------|
| `name` | Standard name shown in report header |
| `sections[]` | Array of evaluation sections (add/remove/reorder) |
| `sections[].id` | Unique section identifier |
| `sections[].name` | Section display name |
| `sections[].weight` | KPI weight (display only) |
| `sections[].keywords` | Conversation scanning keywords |
| `sections[].thresholds` | Numeric thresholds for Superior score |
| `sections[].superiorRules` | Optional rule for combining thresholds |
| `sections[].standard` | 100% score criteria text |
| `sections[].superior` | 120% score criteria text |
| `noiseFilters` | Rules to exclude system/template messages |

### Step 3: Use it / 使用自訂標準

```bash
npx tsx src/cli.ts report --standard my-standard.json
```

### Example: Adding a new section / 新增評核區段範例

```json
{
  "id": "collaboration",
  "name": "AI-Human Collaboration Quality",
  "weight": "30%",
  "standard": {
    "score": 100,
    "label": "Standard",
    "criteria": ["Uses AI for routine tasks", "Follows AI suggestions without modification"]
  },
  "superior": {
    "score": 120,
    "label": "Superior",
    "criteria": ["Actively debates with AI on design decisions", "Synthesizes multiple AI suggestions into novel solutions"]
  },
  "keywords": ["design", "architecture", "trade-off", "pattern", "alternative"],
  "thresholds": {
    "iterativeRatio": 0.4,
    "keywordHits": 15
  },
  "superiorRules": {
    "mode": "grouped",
    "strongThresholds": ["iterativeRatio", "keywordHits"],
    "supportThresholds": ["avgToolUses"],
    "minStrongMatched": 1,
    "minSupportMatched": 0
  }
}
```

### Superior Rules / 升等規則

`superiorRules.mode = "any"` — any matched threshold is enough for 120%.

`superiorRules.mode = "grouped"` — separate strong evidence from support evidence. Strong evidence must meet a minimum count; support evidence alone is not sufficient.

Keys referenced by `strongThresholds` and `supportThresholds` must also exist in `thresholds`.

### Available threshold keys / 可用門檻鍵值

| Key | Description |
|-----|-------------|
| `iterativeRatio` | Ratio of iterative/multi-task sessions to total |
| `correctionCount` | Number of user corrections/interruptions |
| `keywordHits` | Number of keyword signal matches |
| `avgToolUses` | Average tool uses per session |
| `securityCount` | Security-related keyword matches |
| `performanceCount` | Performance-related keyword matches |
| `bugsCaught` | AI-generated bugs caught (from facets) |
| `frictionSessions` | Sessions with friction events |
| `codexIterativeSessions` | Codex threads with strong iterative evidence |
| `codexMultiTurnSessions` | Codex multi-turn threads |
| `codexFollowUpCount` | Codex follow-up user prompts |
| `codexDeepSessions` | Codex high-depth threads |
| `codexErrorSessions` | Codex threads with logged errors |

---

## Default Evaluation Standard / 預設評核標準

The built-in OneAD standard evaluates two dimensions:

### AI Interaction & Decision (20% KPI weight) / AI 交互與決策

| Grade | Criteria |
|-------|----------|
| **Standard (100%)** | Actively use AI for coding; clear decision notes |
| **Superior (120%)** | Multi-iteration guidance (A->B->C); system-constraint-aware optimization |

### AI Identification & Risk Control (50% KPI weight) / AI 識別與風險控管

| Grade | Criteria |
|-------|----------|
| **Standard (100%)** | Catch common AI errors/hallucinations; stable code |
| **Superior (120%)** | Identify critical risks (security, performance, memory); produce SOP/Wiki for team sharing |

---

## Architecture / 架構

```
src/
├── cli.ts                    # CLI entry point (commander)
├── types.ts                  # TypeScript type definitions
├── standard.ts               # Load & validate evaluation standards
├── period.ts                 # Date period resolution (monthly/quarterly)
├── data-quality.ts           # Data source completeness checks
├── utils.ts                  # Shared utilities (noise filter)
├── extractors/
│   ├── claude-code.ts        # Read ~/.claude/ data (JSONL, SQLite, JSON)
│   └── codex.ts              # Read ~/.codex/ data (SQLite, JSONL)
├── analyzers/
│   ├── usage.ts              # Aggregate quantitative usage metrics
│   └── section.ts            # Generic section analyzer (facets + keywords + thresholds)
└── reporters/
    └── report.ts             # Render reports (text, JSON, Markdown)

templates/
└── eval-standard.json        # Default OneAD evaluation standard (source of truth)

tests/
├── cli.test.ts               # CLI regression tests (subprocess)
├── section.test.ts           # Section analyzer unit tests
├── standard.test.ts          # Standard loader/validator tests
├── data-quality.test.ts      # Data quality checker tests
└── fixtures/                 # Test fixture files
```

### Pipeline / 處理流程

```
Extract --> Analyze --> Score --> Report

1. Extract:  Read session-meta, facets, SQLite, JSONL from local stores
2. Analyze:  Aggregate usage + run each section through generic analyzer
3. Score:    Compare metrics against section thresholds
4. Report:   Render in chosen format with evidence and recommendations
```

---

## Development / 開發

### Scripts / 腳本

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run CLI directly via tsx (no build needed)
npm run test         # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
```

### Running tests / 執行測試

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/section.test.ts

# Watch mode
npm run test:watch
```

### Project conventions / 專案慣例

- All progress/status messages are written to **stderr**; report output goes to **stdout**
- JSON output (`--format json`) is guaranteed clean on stdout for piping
- SQLite connections are wrapped in `try/finally` to prevent resource leaks
- The evaluation standard template (`templates/eval-standard.json`) is the single source of truth
- Custom standards inherit default `noiseFilters` if not specified

---

## Troubleshooting / 問題排除

### No sessions found

- Verify `~/.claude/usage-data/session-meta/` contains JSON files
- Check the date range matches when the AI tools were used
- For Codex, verify `~/.codex/state_5.sqlite` exists

### Empty facets

- Facets are generated asynchronously by Claude Code after sessions end
- Recent sessions may not have facets yet
- The tool will show a data quality warning in this case

### JSON output contains extra text

This was fixed in v0.1.0. All progress messages now go to stderr. If you encounter this, ensure you are using the latest version. Use `2>/dev/null` to suppress stderr when piping:

```bash
npx tsx src/cli.ts report --format json 2>/dev/null | jq .
```

---

## License

MIT
