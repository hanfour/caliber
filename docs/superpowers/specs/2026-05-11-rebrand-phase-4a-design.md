# Rebrand Phase 4a — README / Monitoring / Design Docs

**Date:** 2026-05-11
**Scope:** Closes GitHub issues #122, #123, #125
**Out of scope:** #120 (CLI), #121 (HKDF v2), #124 (Grafana UIDs), #126 (URLs blocked on repo rename)
**Risk class:** Zero runtime change. Configuration, docs, and observability templates only.

## Goals

Finish the long tail of `aide → Caliber` rebranding left over from PR #117 (Phase 3 infra) and PR #119 (Phase 3.5 dev tooling + npm meta) for surfaces where:

- The disclaimer in `README.md` is now factually wrong (Phase 3 already migrated DB / Redis / launchd).
- Prometheus alert rules and example scrape config still say `aide-*`, despite the gateway/api code already emitting metrics under that brand-agnostic shape (job labels are scrape-side).
- Five long-form design documents still narrate the system as `aide`.

This PR does not touch any code that affects request handling, persisted state, or operator data on disk.

## Approach

One bundled PR (`refactor/phase-4a-rebrand-bundle`) with three commits, one per closed issue. Matches the operator's stated preference for bundling related rebrand work over micro-PRs.

```
docs: drop original-codename disclaimer from README (#122)
refactor(monitoring): rename Prometheus alert groups + job labels aide → caliber (#123)
docs(design): rebrand long-form design docs aide → Caliber (#125)
```

Merge style: `gh pr merge <NN> --rebase --delete-branch` (linear history, repo convention).

After merge, manually close #122 / #123 / #125 with `gh issue close` because rebase merges do not always trigger GitHub's auto-close.

## Per-issue change rules

### #122 — README disclaimer

`README.md`: delete the entire `> Original codename: aide. …` blockquote (currently line 7) plus the trailing `---` rule that follows it. The disclaimer was accurate at the time of Phase 2; Phase 3 already migrated production DB / Redis / launchd, so the only items it still describes truthfully (`ghcr.io/hanfour/aide-*` images, `hanfour/aide` Docker build context) are blocked on #126 (repo rename) and belong in that PR, not this one.

### #123 — Prometheus + monitoring docs

Four files:

1. **`monitoring/prometheus/alerts.yml`**
   - Rename 7 alert group names: `aide-liveness` / `-rate-limit` / `-failover` / `-oauth` / `-workers` / `-billing` / `-gdpr` → `caliber-*`.
   - Rename scrape-job labels inside expressions: `job="aide-gateway"` → `job="caliber-gateway"`, `job="aide-api"` → `job="caliber-api"`.
   - Update narrative comment / summary / description text from `aide` → `Caliber` (brand prose) and from `aide-gateway` / `aide-api` (job-name references) to `caliber-*`.
2. **`ops/prometheus/alerts.yml`**
   - Rename 3 alert group names: `aide-evaluator` / `aide-body-capture` / `aide-gdpr` → `caliber-*`.
   - Same label and prose treatment as above.
3. **`monitoring/prometheus/scrape.example.yml`**
   - Rename `job_name: aide-gateway` → `caliber-gateway`, `job_name: aide-api` → `caliber-api`.
   - Update any inline comments that name the jobs.
4. **`monitoring/README.md`**
   - Replace title and prose `aide` → `Caliber`.
   - Suggested example file path `aide-alerts.yml` → `caliber-alerts.yml`.
   - Group-name list update to mirror the renamed groups in (1).

### #125 — Long-form design docs

Five files: `docs/OAUTH_REFRESH_DESIGN.md` (≈31 hits), `docs/SELF_HOSTING.md` (≈14), `docs/MULTI_DEVICE.md` (≈19), `docs/GATEWAY.md` (≈6), `docs/EVALUATOR.md` (≈1).

Three categories of references, three rules:

| Category | Rule |
|---|---|
| Brand / product name (e.g. "aide gateway", "Self-hosting aide", `aide.example.com`) | Rename to Caliber. CLI invocations in examples (`aide …`) → `caliber …` to match PR #119 bin rename. |
| Identifiers already aligned to current code (e.g. `aide:gw:*` Redis keys) | Rename to `caliber:gw:*`. Code was migrated in PR #117 (Phase 3); doc was stale, not aspirational. |
| Factually correct references to unshipped state (HKDF info strings `"aide-gateway-body-v1"`, `"aide-gateway-credential-v1"`) | Keep verbatim. At first occurrence in each doc, add a one-line inline annotation: `(v1, will become caliber-gateway-*-v2 in #121)`. |

After mechanical rename, hand-pass each doc for awkward sentences. Do not invent new content; do not remove sections.

## What stays intentionally `aide`

- `packages/gateway-core/src/crypto/{bodyCipher,credentialCipher}.ts` constants `BODY_INFO` / `CREDENTIAL_INFO` — owned by #121.
- `src/cli.ts` / `src/config.ts` / `src/i18n.ts` strings — owned by #120 (needs migration shim).
- `.claude/plans/*.md` historical plan documents — frozen-in-time, not in any issue's scope.
- `ghcr.io/hanfour/aide-*`, `hanfour/aide` repo URL — owned by #126, blocked on GitHub web-UI rename.

## Verification

This PR changes no runtime code, so no docker rebuild + smoke is required. Verification is:

1. `pnpm lint` / `pnpm typecheck` green (no source files touched, but runs anyway via CI).
2. `promtool check rules monitoring/prometheus/alerts.yml ops/prometheus/alerts.yml` reports no errors. If `promtool` is not available locally, fall back to `yq` / `python -c "import yaml; yaml.safe_load(open(...))"` to confirm valid YAML.
3. Markdown internal links not broken: spot-check anchors and relative paths in the 5 design docs.
4. Residual check: `grep -in "aide" docs/{OAUTH_REFRESH_DESIGN,GATEWAY,MULTI_DEVICE,SELF_HOSTING,EVALUATOR}.md` returns only the 3 deliberately kept `aide-gateway-*-v1` HKDF lines.
5. No friendly-fire: `grep -rn "aide" README.md monitoring/ ops/` returns nothing (or only quoted historical context that escaped review — flag for hand decision).

Alertmanager configuration (`ops/alertmanager/alertmanager.yml.example`) does not match on `aide-*` group names; it routes by `alertname` and `severity` only. **No alertmanager change is needed.**

## Operator upgrade

Required after PR merge:

1. Update local `prometheus.yml`: `job_name: aide-gateway` → `caliber-gateway`, `job_name: aide-api` → `caliber-api`.
2. Restart Prometheus (`docker compose restart prometheus` or equivalent).
3. If `alerts.yml` is mounted directly from the repo path, the restart picks up new group names automatically; otherwise `cp` the new file and `reload`.
4. (Optional) Rename the alerts file on disk (`aide-alerts.yml` → `caliber-alerts.yml`) and update `rule_files:` in `prometheus.yml` accordingly.
5. Alertmanager: **no action required.**

## PR body skeleton

```
## TL;DR
Phase 4a — finish aide → Caliber for non-runtime surfaces: README disclaimer, Prometheus alert rules, 5 design docs. Zero runtime change.

## Why
PR #117 migrated production DB/Redis/launchd; PR #119 cleaned dev tooling + npm meta. Three categories were deliberately deferred and tracked as #122 / #123 / #125. This PR closes all three.

## What's in
- README: drop original-codename disclaimer block
- Prometheus: rename 10 alert groups + scrape job labels + monitoring/README
- Design docs: rebrand 5 docs; keep `aide-gateway-*-v1` HKDF strings annotated with forward reference to #121

## What's NOT in
- #120 CLI (needs ~/.aide.json migration shim)
- #121 HKDF v2 (data-migration risk)
- #124 Grafana UIDs (strategy decision still open)
- #126 GitHub URL fields (blocked on repo rename)

## Tests
- pnpm lint / typecheck green
- promtool check rules green on both alerts.yml
- Residual grep clean except 3 deliberate v1 HKDF references

## Operator upgrade
- Update prometheus.yml job_name: aide-* → caliber-*
- Restart Prometheus
- Alertmanager: no action required
- (Optional) Rename alerts file on disk, update rule_files accordingly

## Closes
Closes #122, #123, #125
```

## Self-review

- Placeholder scan: none.
- Internal consistency: PR body skeleton matches per-issue change rules; "what stays aide" matches "out of scope" exactly.
- Scope: single bundled PR is appropriate; each issue has independent verification.
- Ambiguity: `monitoring/README.md` is explicitly in commit 2 (was a section-2 review question, resolved during walkthrough).
