# Upgrade guide — v0.4.x → v0.5.0 (Plan 4C)

## Summary

v0.5.0 ships **Plan 4C**, which extends the Plan 4B evaluator with two new
capabilities:

1. **LLM cost budget infrastructure** — per-org monthly USD budget on LLM
   spend (deep-analysis + facet extraction combined), an immutable spend
   ledger (`llm_usage_events`), warn / degrade / halt enforcement, and an
   admin-facing `/admin/evaluator/costs` dashboard.
2. **LLM facet extraction** — opt-in per-session classification (session
   type, outcome, helpfulness, friction / bugs / errors counts) stored in
   `request_body_facets`. Six new facet-driven signal aggregators are
   available to rubric authors.

Both subsystems are off by default. The cost budget infra activates the
moment an org sets a budget; facet extraction additionally requires a
server-wide feature flag.

The release also drops `linux/arm64` from the `web` Docker image — see
breaking changes below.

---

## Breaking changes

- **Web image is `linux/amd64`-only.** The `caliber-web` Docker image no
  longer publishes an `arm64` tag (Plan 4C Phase 1 Part 12). Reason:
  Next.js production builds on arm64 emulation in CI exceed the GitHub
  Actions 6h timeout. The `gateway` and `api` images continue to ship
  multi-arch.
  - **Impact:** if you self-host on arm64 hardware (e.g. Apple Silicon
    Docker hosts, AWS Graviton), pull the `linux/amd64` image and run
    via emulation, or build the `caliber-web` image locally for your
    architecture.
- **Schema additions only.** Migrations 0004 and 0005 add new columns
  and tables. No existing columns change shape, no data is rewritten.
  Down-migrations are provided (see Rollback below).

---

## Step-by-step upgrade

1. **Backup the database.** Plan 4C touches the `organizations` table
   (new columns) and adds `request_body_facets`. Take a snapshot first:
   ```bash
   pg_dump $DATABASE_URL > backup-pre-v0.5.0.sql
   ```

2. **Pull new images.**
   ```bash
   docker-compose pull
   ```

3. **Restart services.** Migrations 0004 (cost budget columns +
   `llm_usage_events`) and 0005 (`request_body_facets`) run
   automatically on startup:
   ```bash
   docker-compose up -d
   ```
   Watch logs to confirm migrations succeeded:
   ```bash
   docker-compose logs api | grep -i migrat
   ```

4. **Verify Settings UI.** Open the org settings page in the web app
   (`/dashboard/organizations/[id]/settings`). Two new sections should
   appear:
   - **LLM cost budget** — monthly USD budget, overage behavior
     (`degrade` / `halt`).
   - **LLM facet extraction** — toggle + facet-model picker (greyed out
     when LLM evaluation is disabled).

5. **(Recommended) set a monthly budget.** Production orgs should opt
   into the budget infra. Pick a number that comfortably exceeds your
   expected monthly spend (e.g. 2× your historical Plan 4B LLM cost).
   With `degrade` behavior the worst-case overage is one in-flight call;
   with `halt` you trade tighter spend control for a cold start at the
   month boundary.

6. **(Optional) enable facet extraction.** Two-level opt-in:
   - **Server flag.** Set `ENABLE_FACET_EXTRACTION=true` in the gateway
     env file:
     ```env
     ENABLE_FACET_EXTRACTION=true
     ```
   - **Org flag.** In the org settings UI, toggle *Enable facet
     extraction* and choose a facet model (Haiku is recommended — facets
     are short JSON outputs, Sonnet is overkill).
   - **Restart the gateway** so the new flag is picked up.
   - **Note (v0.5.0 only):** the worker wiring for facet extraction is
     deferred to a follow-up — see *Known follow-ups* below. Setting the
     flag and toggle today persists the configuration but does not yet
     trigger live extraction.

7. **(Optional) install Grafana dashboards.** If you run the supplied
   Prometheus / Grafana stack:
   ```bash
   cp ops/grafana/*.json /etc/grafana/provisioning/dashboards/
   systemctl reload grafana-server
   ```
   Three new dashboards appear: *LLM Cost*, *Facet Extraction*, and
   updates to the existing *Evaluator* board.

8. **(Optional) wire alert rules.** If you run Alertmanager:
   ```bash
   cat ops/prometheus/alerts.yml >> /etc/prometheus/rules.d/caliber.yml
   cp ops/alertmanager/alertmanager.yml.example /etc/alertmanager/alertmanager.yml
   # edit alertmanager.yml — set receivers (Slack/PagerDuty/email)
   systemctl reload prometheus alertmanager
   ```
   New alert families: `LlmBudget*`, `FacetExtraction*`. Runbook links
   are baked into each alert annotation; see `docs/runbooks/`.

---

## Rollback

Three layers, in order of preference (try the cheapest first):

### 1. Feature-flag rollback (preferred)

To disable facet extraction without touching data or schema:
```env
ENABLE_FACET_EXTRACTION=false
```
Restart the gateway. Existing `request_body_facets` rows are retained
for later re-enable, but no new extractions run. The cost budget
subsystem is independent and stays active.

### 2. Per-org rollback

To disable both subsystems for a single org without affecting others:
```sql
UPDATE organizations
SET llm_facet_enabled = false,
    llm_facet_model = NULL,
    llm_monthly_budget_usd = NULL,
    llm_halted_until_month_end = false
WHERE id = '<org-id>';
```

### 3. Schema rollback

If a defect requires reverting both migrations:
```bash
psql $DATABASE_URL -f packages/db/drizzle/0005_down.sql
psql $DATABASE_URL -f packages/db/drizzle/0004_down.sql
```
After running the down-migrations you must **manually edit**
`packages/db/drizzle/meta/_journal.json` to remove entries `0004` and
`0005`, otherwise the next deploy will refuse to start (mismatched
journal vs. live schema). Re-deploy the previous image (v0.4.x) once
the journal matches.

---

## Known follow-ups

The components below shipped in v0.5.0 but the final wiring is deferred
to a subsequent point release. They do **not** block adoption — the
released subsystems work as documented above.

- **Worker wiring of `ensureFacets` is deferred.** All facet components
  ship in v0.5.0 (prompt builder, parser, extractor, `ensureFacets`
  batch caller, `facetWriter`, `facetCache`, six signal aggregators)
  and are independently tested end-to-end against a real Postgres in
  `apps/gateway/tests/workers/evaluator/ensureFacets.integration.test.ts`.
  The remaining glue — invoking `ensureFacets` from
  `apps/gateway/src/workers/evaluator/runEvaluation.ts` after rule-based
  signals are computed — was deferred to keep this release focused. The
  integration requires three additional pieces:
    1. A concrete `LlmClient` (per the `@caliber/evaluator/llm` interface)
       that calls the gateway loopback for facet extraction, mirroring
       `runLlm.ts`'s approach for deep analysis.
    2. A `BodyRow → FacetSession` adapter that flattens
       Anthropic-shaped request/response bodies into `Turn[]`.
    3. Wiring `callWithCostTracking` + `wrapEnforceBudget` +
       `createLedgerWriter` + `createBudgetDeps` + `createFacetWriter`
       + `createFacetCacheReader` into a `FacetCallDeps` and
       `EnsureFacetsDeps` pair, gated on
       `ENABLE_FACET_EXTRACTION && org.llm_facet_enabled &&
       org.llm_facet_model`, with fail-soft error handling so a facet
       failure never blocks rule-based scoring.
  Track in a follow-up issue. Until shipped, rubric authors **cannot**
  yet exercise the facet signal aggregators against live data — but
  they can exercise them against test fixtures via
  `signals/facet.test.ts`.

- **Migration 0006 (platform rubric v2) is deferred.** The current
  platform-default rubric in `apps/gateway/src/workers/evaluator/fixtures/platformDefault.ts`
  works as before. Custom org rubrics can opt into facet signals today
  by hand-editing rubric JSON — once the wiring above lands, a v2
  platform rubric with default facet thresholds will replace this.

- **`organizations.llm_halted_at` column is missing.** The cost-budget
  infra works correctly without it, but every halted call pays the cost
  of `clearHalt` + `setHalt` instead of a flag-read short-circuit (see
  `apps/gateway/src/workers/evaluator/budgetDeps.ts` header for full
  rationale). Adding the column lets `enforceBudget` short-circuit on
  same-month halts and closes a small race window.

- **Report UI does not yet surface facet drill-down.** Facet rows are
  written to `request_body_facets` and aggregated by the signal
  aggregators, but the per-user evaluation report page does not yet
  display the underlying facet classifications. Admins can query the
  table directly until the report UI is extended.

- **Rubric editor does not yet expose facet signal types.** The six
  facet aggregators (`facet_session_type_mix`,
  `facet_outcome_distribution`, `facet_avg_helpfulness`,
  `facet_friction_rate`, `facet_bugs_caught_total`,
  `facet_codex_error_rate`) must currently be added to a rubric via
  direct SQL `UPDATE` on `rubrics.definition`, or via the future admin
  UI.

- **End-to-end Playwright specs are deferred.** v0.5.0 ships unit +
  integration coverage for every shipped component; full-stack browser
  E2E specs covering the new settings UI and admin cost dashboard are
  planned for a follow-up.

---

## Configuration reference

New environment variables introduced in v0.5.0:

| Var | Default | Purpose |
|---|---|---|
| `ENABLE_FACET_EXTRACTION` | `false` | Server-wide kill switch for facet extraction. Required (`true`) for any org-level toggle to take effect. |

New `organizations` columns (set per-org via Settings UI or SQL):

| Column | Default | Purpose |
|---|---|---|
| `llm_monthly_budget_usd` | `NULL` | Monthly USD ceiling for LLM spend. `NULL` means unlimited. |
| `llm_budget_overage_behavior` | `'degrade'` | `degrade` (skip the over-budget call) or `halt` (set the halt flag, refuse calls until next UTC month). |
| `llm_halted_until_month_end` | `false` | Set by `enforceBudget` when `halt` behavior triggers. Cleared at the next UTC month boundary. |
| `llm_facet_enabled` | `false` | Per-org opt-in to facet extraction. Requires `ENABLE_FACET_EXTRACTION=true` server-wide. |
| `llm_facet_model` | `NULL` | Model used for facet extraction (e.g. `claude-haiku-4-5`). Required when `llm_facet_enabled=true`. |

---

## Verification checklist

After upgrading:

- [ ] `docker-compose ps` shows all services healthy.
- [ ] `/health` on gateway, api, web all return 200.
- [ ] Migrations `0004` and `0005` applied (`SELECT * FROM
      __drizzle_migrations ORDER BY id DESC LIMIT 5`).
- [ ] Settings UI shows the new cost-budget and facet sections for at
      least one org.
- [ ] (If wired) `/admin/evaluator/costs` page renders without error.
- [ ] Prometheus is scraping the new `gw_llm_*` and (when wired)
      `gw_facet_*` metrics.

---

## Further reading

- Plan 4C design doc: `.claude/plans/2026-04-24-plan-4c-design.md`
- Plan 4C implementation plan: `.claude/plans/2026-04-24-plan-4c-implementation.md`
- Runbooks:
  - `docs/runbooks/llm-budget.md`
  - `docs/runbooks/cost-ledger-mismatch.md`
  - `docs/runbooks/facet-extraction.md`
  - `docs/runbooks/facet-parse-errors.md`
  - `docs/runbooks/evaluator-rollout.md`
