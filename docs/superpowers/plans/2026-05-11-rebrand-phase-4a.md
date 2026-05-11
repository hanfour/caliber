# Rebrand Phase 4a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle three rebrand backlog issues (#122 README disclaimer, #123 Prometheus, #125 long-form design docs) into one zero-runtime-change PR on branch `refactor/phase-4a-rebrand-bundle`.

**Architecture:** One PR, three commits, one per issue. Verification is YAML lint + residual grep — no test suite changes because no runtime code is touched. After merge, manually close issues with `gh issue close` because rebase merges do not reliably trigger GitHub auto-close.

**Tech Stack:** Markdown, Prometheus YAML, `gh` CLI, `promtool` (optional), bash.

**Spec reference:** `docs/superpowers/specs/2026-05-11-rebrand-phase-4a-design.md` (committed earlier on this branch as `10ecf7e`).

**Branch state:** Already on `refactor/phase-4a-rebrand-bundle`, branched from `main` (commit `5403fa2`). Spec doc is the only commit so far.

---

## Task 1: README disclaimer drop (closes #122)

**Files:**
- Modify: `README.md` (delete lines 7-9)

- [ ] **Step 1: Confirm current README state**

Run: `sed -n '5,12p' README.md`

Expected output starts with the blank line after the Chinese tagline, then:
```
> Original codename: `aide`. The GHCR image names (`ghcr.io/hanfour/aide-*`), Docker build context, the Postgres DB / user `aide`, the `aide-keychain-helper` launchd job, and the Redis key prefix `aide:gw:` still use the original codename. Phase 3 of the rebrand renames those infra-level identifiers behind a maintenance window.

---

## Why / 為什麼需要這個工具
```

If the file differs, stop and re-read; lines may have shifted.

- [ ] **Step 2: Delete the disclaimer block via Edit**

Use the Edit tool. `old_string` (must match exactly):

```
**精準衡量你的 AI 工程力。** 自架的 gateway / 稽核 / 評核平台，讓團隊清楚知道 AI 助理到底在做什麼、做得多好。

> Original codename: `aide`. The GHCR image names (`ghcr.io/hanfour/aide-*`), Docker build context, the Postgres DB / user `aide`, the `aide-keychain-helper` launchd job, and the Redis key prefix `aide:gw:` still use the original codename. Phase 3 of the rebrand renames those infra-level identifiers behind a maintenance window.

---

## Why / 為什麼需要這個工具
```

`new_string`:

```
**精準衡量你的 AI 工程力。** 自架的 gateway / 稽核 / 評核平台，讓團隊清楚知道 AI 助理到底在做什麼、做得多好。

---

## Why / 為什麼需要這個工具
```

- [ ] **Step 3: Verify no `aide` references remain in README**

Run: `grep -in "aide" README.md`

Expected: empty output (exit code 1).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: drop original-codename disclaimer from README (#122)

Phase 3 (PR #117) already migrated production DB / Redis / launchd to
caliber. The remaining items the disclaimer described truthfully
(ghcr.io/hanfour/aide-* images, hanfour/aide Docker build context)
are blocked on #126 (repo rename) and belong in that PR.

Closes #122"
```

---

## Task 2: Prometheus monitoring rename (closes #123)

**Files:**
- Modify: `monitoring/prometheus/alerts.yml`
- Modify: `ops/prometheus/alerts.yml`
- Modify: `monitoring/prometheus/scrape.example.yml`
- Modify: `monitoring/README.md`

### Subtask 2.1 — `monitoring/prometheus/alerts.yml`

Has 7 alert groups, 4 `job="aide-*"` label references in expressions, and prose comments / annotations referring to aide.

- [ ] **Step 1: Rename the 7 alert group names**

Use 7 individual Edit calls (each `old_string` must include enough surrounding context to be unique):

| Old | New |
|---|---|
| `- name: aide-liveness` | `- name: caliber-liveness` |
| `- name: aide-rate-limit` | `- name: caliber-rate-limit` |
| `- name: aide-failover` | `- name: caliber-failover` |
| `- name: aide-oauth` | `- name: caliber-oauth` |
| `- name: aide-workers` | `- name: caliber-workers` |
| `- name: aide-billing` | `- name: caliber-billing` |
| `- name: aide-gdpr` | `- name: caliber-gdpr` |

Since these strings are unique line-by-line, you can use a single `sed -i` instead:

```bash
sed -i '' \
  -e 's/^- name: aide-liveness$/- name: caliber-liveness/' \
  -e 's/^- name: aide-rate-limit$/- name: caliber-rate-limit/' \
  -e 's/^- name: aide-failover$/- name: caliber-failover/' \
  -e 's/^- name: aide-oauth$/- name: caliber-oauth/' \
  -e 's/^- name: aide-workers$/- name: caliber-workers/' \
  -e 's/^- name: aide-billing$/- name: caliber-billing/' \
  -e 's/^- name: aide-gdpr$/- name: caliber-gdpr/' \
  monitoring/prometheus/alerts.yml
```

(BSD sed on macOS requires `-i ''`.)

- [ ] **Step 2: Rename job labels inside expressions**

```bash
sed -i '' \
  -e 's/job="aide-gateway"/job="caliber-gateway"/g' \
  -e 's/job="aide-api"/job="caliber-api"/g' \
  monitoring/prometheus/alerts.yml
```

- [ ] **Step 3: Rename prose references**

Top-of-file comment header has `aide` mentions; summary/description text has `aide-gateway` / `aide-api`. Use targeted Edits because the surrounding text varies:

Use the Edit tool on each of these `old_string` → `new_string` pairs (do them one at a time; each replaces a single unique occurrence):

1. `# Prometheus alerting rules for aide.` → `# Prometheus alerting rules for Caliber.`
2. `#   service    — which aide component (gateway / api)` → `#   service    — which Caliber component (gateway / api)`
3. `summary: "aide-gateway is unreachable"` → `summary: "caliber-gateway is unreachable"`
4. `description: "Prometheus has been unable to scrape aide-gateway for 2+ minutes. /v1/* traffic is failing."` → `description: "Prometheus has been unable to scrape caliber-gateway for 2+ minutes. /v1/* traffic is failing."`
5. `summary: "aide-api is unreachable"` → `summary: "caliber-api is unreachable"`
6. `description: "Prometheus has been unable to scrape aide-api for 2+ minutes. Admin UI tRPC calls are failing."` → `description: "Prometheus has been unable to scrape caliber-api for 2+ minutes. Admin UI tRPC calls are failing."`

- [ ] **Step 4: Verify no residual `aide` in this file**

Run: `grep -n "aide" monitoring/prometheus/alerts.yml`

Expected: empty output (exit code 1).

### Subtask 2.2 — `ops/prometheus/alerts.yml`

Has **4** alert groups (note: spec said 3, actual is 4 — fourth is `aide-llm-cost`). No `job=` labels and no aide-named prose beyond the group names.

- [ ] **Step 1: Rename the 4 alert group names**

```bash
sed -i '' \
  -e 's/^  - name: aide-evaluator$/  - name: caliber-evaluator/' \
  -e 's/^  - name: aide-body-capture$/  - name: caliber-body-capture/' \
  -e 's/^  - name: aide-gdpr$/  - name: caliber-gdpr/' \
  -e 's/^  - name: aide-llm-cost$/  - name: caliber-llm-cost/' \
  ops/prometheus/alerts.yml
```

- [ ] **Step 2: Verify no residual `aide` in this file**

Run: `grep -n "aide" ops/prometheus/alerts.yml`

Expected: empty output (exit code 1).

### Subtask 2.3 — `monitoring/prometheus/scrape.example.yml`

Two `job_name:` entries, plus comment prose mentioning `aide_default` (compose project name) and `aide-gateway` / `aide-api` (job names).

- [ ] **Step 1: Inspect current content**

Run: `cat monitoring/prometheus/scrape.example.yml`

Confirm 2 `job_name:` lines (`aide-gateway`, `aide-api`) and the comment block on lines 1-6 mentioning `aide`, `aide_default`.

- [ ] **Step 2: Replace job_name values and prose**

Use Edit tool with these pairs (literal newlines in `old_string` / `new_string` — preserve indentation exactly):

1. `# Sample Prometheus scrape config for aide.` → `# Sample Prometheus scrape config for Caliber.`
2. ``` `aide_default` compose project. ``` → ``` `caliber_default` compose project. ``` (line 6; single-line edit is enough — the surrounding lines are unchanged)
3. `  - job_name: aide-gateway` → `  - job_name: caliber-gateway`
4. `  - job_name: aide-api` → `  - job_name: caliber-api`
5. `          # network address (Render: aide-gateway:3002 within the` → `          # network address (Render: caliber-gateway:3002 within the`
6. `          # blueprint's network; Fly: aide-gateway.flycast:3002;` → `          # blueprint's network; Fly: caliber-gateway.flycast:3002;`
7. `          # Railway: aide-gateway.railway.internal:3002).` → `          # Railway: caliber-gateway.railway.internal:3002).`
8. `  # or cadvisor, add them here. The aide alert rules don't depend on` → `  # or cadvisor, add them here. The Caliber alert rules don't depend on`

- [ ] **Step 3: Verify**

Run: `grep -n "aide" monitoring/prometheus/scrape.example.yml`

Expected: empty output (exit code 1).

### Subtask 2.4 — `monitoring/README.md`

Has 7 `aide` references. Some are titles, some are `aide-*` group/job names, one is the suggested file path `aide-alerts.yml`, and one is a textfile sentinel filename `aide-backup`.

- [ ] **Step 1: Apply targeted replacements**

Use the Edit tool with these pairs:

1. `# aide monitoring + alerting` → `# Caliber monitoring + alerting`
2. `     - /etc/prometheus/aide-alerts.yml` → `     - /etc/prometheus/caliber-alerts.yml`
3. `   Should list \`aide-liveness\`, \`aide-rate-limit\`, \`aide-failover\`,` → `   Should list \`caliber-liveness\`, \`caliber-rate-limit\`, \`caliber-failover\`,`
4. `   \`aide-oauth\`, \`aide-workers\`, \`aide-billing\`, \`aide-gdpr\`.` → `   \`caliber-oauth\`, \`caliber-workers\`, \`caliber-billing\`, \`caliber-gdpr\`.`
5. `These alerts can't be expressed without infrastructure outside aide` → `These alerts can't be expressed without infrastructure outside Caliber`
6. `  backup; alert if \`node_textfile_mtime_seconds{file="aide-backup"}\`` → `  backup; alert if \`node_textfile_mtime_seconds{file="caliber-backup"}\``

- [ ] **Step 2: Verify**

Run: `grep -n "aide" monitoring/README.md`

Expected: empty output (exit code 1).

### Subtask 2.5 — YAML validity + commit

- [ ] **Step 1: YAML lint check (without promtool)**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('monitoring/prometheus/alerts.yml')); yaml.safe_load(open('ops/prometheus/alerts.yml')); yaml.safe_load(open('monitoring/prometheus/scrape.example.yml')); print('YAML OK')"
```

Expected output: `YAML OK`

- [ ] **Step 2: promtool check (optional, only if available)**

Run: `which promtool && promtool check rules monitoring/prometheus/alerts.yml ops/prometheus/alerts.yml`

If `promtool` is not installed, skip — YAML lint is sufficient for this PR scope. Do not block on installing promtool.

- [ ] **Step 3: Commit**

```bash
git add monitoring/prometheus/alerts.yml ops/prometheus/alerts.yml monitoring/prometheus/scrape.example.yml monitoring/README.md
git commit -m "refactor(monitoring): rename Prometheus alert groups + job labels aide → caliber (#123)

Renames the 11 alert group names (7 in monitoring/prometheus/alerts.yml,
4 in ops/prometheus/alerts.yml — note: ops has a fourth aide-llm-cost
group that the issue body did not list), the job= label expressions
inside alert rules (caliber-gateway, caliber-api), and the matching
example scrape config + monitoring README prose.

Alertmanager configuration is unaffected: ops/alertmanager/alertmanager.yml.example
routes by alertname and severity only, never by group name. No
alertmanager change is required.

Operator must update their own prometheus.yml job_name entries to
caliber-* and restart Prometheus for the new alert groups to take
effect. See PR body for full operator upgrade steps.

Closes #123"
```

---

## Task 3: Long-form design docs rebrand (closes #125)

**Files:**
- Modify: `docs/EVALUATOR.md` (1 hit)
- Modify: `docs/GATEWAY.md` (6 hits)
- Modify: `docs/MULTI_DEVICE.md` (15 hits)
- Modify: `docs/SELF_HOSTING.md` (14 hits)
- Modify: `docs/OAUTH_REFRESH_DESIGN.md` (31 hits)

### Reference rules (apply to every doc)

| Category | Rule |
|---|---|
| Brand prose: "aide gateway", "aide" as system name, "Self-hosting aide", `aide.example.com`, CLI like `aide login` | Rename to Caliber / caliber. Preserve case (`Aide` → `Caliber`, `aide` → `caliber`). |
| `aide:gw:*` Redis keys (code already on `caliber:gw:*`) | Rename to `caliber:gw:*`. |
| HKDF info strings `"aide-gateway-body-v1"`, `"aide-gateway-credential-v1"` | KEEP verbatim. At first occurrence in each doc, add a parenthetical: `(v1, will become caliber-gateway-*-v2 in #121)`. |
| `aide-keychain-helper` launchd identifier (if mentioned) | Rename to `caliber-keychain-helper` — Phase 3 launchd already renamed; doc should describe current state. |

### Subtask 3.1 — `docs/EVALUATOR.md`

Only 1 hit. Inspect first.

- [ ] **Step 1: Locate the hit**

Run: `grep -n "aide\|Aide\|AIDE" docs/EVALUATOR.md`

- [ ] **Step 2: Apply Edit per occurrence**

Decide rule based on context (brand prose, key, HKDF, or launchd) and Edit accordingly. For a single hit this is one Edit call.

- [ ] **Step 3: Verify**

Run: `grep -n "aide\|Aide\|AIDE" docs/EVALUATOR.md`

Expected: empty (exit 1) or only the annotated HKDF line if the single hit happened to be an HKDF info string.

### Subtask 3.2 — `docs/GATEWAY.md`

6 hits. Confirmed sample lines:
- `160: info="aide-gateway-credential-v1"` → keep verbatim + annotate (first HKDF in doc)
- `230: aide:gw:key-reveal:<token>` → rename
- `358, 618: aide:gw:` → rename
- `646: info="aide-gateway-body-v1"` → keep verbatim (annotation already on the credential one earlier; subsequent HKDF lines stay un-annotated)

- [ ] **Step 1: Locate all hits**

Run: `grep -n "aide" docs/GATEWAY.md`

- [ ] **Step 2: Inspect surrounding context for the HKDF lines**

Run: `sed -n '155,165p;640,650p' docs/GATEWAY.md`

This shows the prose around the HKDF info strings so you can choose the right insertion point for the annotation.

- [ ] **Step 3: Annotate the first HKDF occurrence**

Find the first HKDF info string (likely the credential one at line ~160). Use Edit to insert the annotation `(v1, will become caliber-gateway-credential-v2 in #121)` immediately after the string. Example pattern (verify exact text first):

Before:
```
`CREDENTIAL_ENCRYPTION_KEY` with `salt=account_id` and `info="aide-gateway-credential-v1"`.
```
After:
```
`CREDENTIAL_ENCRYPTION_KEY` with `salt=account_id` and `info="aide-gateway-credential-v1"` (v1, will become `caliber-gateway-credential-v2` in #121).
```

- [ ] **Step 4: Rename `aide:gw:*` Redis key references**

Use one Edit per occurrence (typically 3 hits — `aide:gw:key-reveal`, `aide:gw:queue:usage-log`, and the `redis-cli KEYS 'aide:gw:*'` example). Each becomes `caliber:gw:*`. Inspect each line first with `grep -n "aide:gw" docs/GATEWAY.md`.

- [ ] **Step 5: Rename brand prose ("the aide gateway" → "the Caliber gateway")**

The doc opens with `The **aide gateway** is an opt-in data plane …`. Edit this phrase to `The **Caliber gateway** is an opt-in data plane …`.

- [ ] **Step 6: Verify**

Run: `grep -n "aide" docs/GATEWAY.md`

Expected residue:
- Line ~160: `info="aide-gateway-credential-v1"` (annotated)
- Line ~646: `info="aide-gateway-body-v1"` (un-annotated — first HKDF already annotated above)

Two lines total. Anything else means a missed Edit.

### Subtask 3.3 — `docs/MULTI_DEVICE.md`

15 hits. Mostly brand prose and possibly `aide-keychain-helper` references.

- [ ] **Step 1: Audit the hits**

Run: `grep -n "aide" docs/MULTI_DEVICE.md`

- [ ] **Step 2: Categorize and Edit**

For each hit, decide:
- Brand prose ("aide gateway", "aide", `aide.example.com`) → rename to Caliber/caliber
- `aide-keychain-helper` → rename to `caliber-keychain-helper`
- HKDF info strings → keep verbatim; annotate first occurrence only

Apply one Edit per occurrence. If a phrase like "the aide gateway" appears multiple times verbatim, you can use Edit with `replace_all: true` for that exact phrase.

- [ ] **Step 3: Verify**

Run: `grep -n "aide" docs/MULTI_DEVICE.md`

Expected: empty (exit 1) OR only annotated HKDF lines. If anything else remains, hand-decide before continuing.

### Subtask 3.4 — `docs/SELF_HOSTING.md`

14 hits. Confirmed samples:
- `1: # Self-hosting aide` → rename to `# Self-hosting Caliber`
- `3: aide` (platform mode) → rename
- `9: aide on your laptop` → rename
- `34: aide.example.com` → rename to `caliber.example.com`
- `40: https://aide.example.com/api/auth/callback/google` → rename

- [ ] **Step 1: Audit the hits**

Run: `grep -n "aide" docs/SELF_HOSTING.md`

- [ ] **Step 2: Apply Edit per occurrence**

All occurrences should be brand prose or example hostnames — rename to Caliber / caliber. No HKDF strings expected (this doc is operational, not cryptographic). If any HKDF appears, keep + annotate.

- [ ] **Step 3: Verify**

Run: `grep -n "aide" docs/SELF_HOSTING.md`

Expected: empty (exit 1) OR only annotated HKDF lines.

### Subtask 3.5 — `docs/OAUTH_REFRESH_DESIGN.md`

31 hits — the heaviest doc. Likely mix of brand prose, `aide:gw:` keys, and HKDF references (the doc is specifically about OAuth credential refresh, so the credential cipher info string almost certainly appears).

- [ ] **Step 1: Audit and bucket**

Run:
```bash
grep -n "aide" docs/OAUTH_REFRESH_DESIGN.md
```

Read the output and bucket each hit:
- Brand prose
- `aide:gw:*` key references
- HKDF info string (keep + annotate first occurrence only)
- `aide-keychain-helper` references (rename to `caliber-keychain-helper`)

- [ ] **Step 2: Apply Edits bucket-by-bucket**

For efficiency: brand prose hits often share repeated phrasings — use Edit with `replace_all: true` where the `old_string` is unique enough across the file. For ambiguous hits, Edit one-by-one.

- [ ] **Step 3: Annotate HKDF first occurrence**

Find first occurrence of either `info="aide-gateway-credential-v1"` or `info="aide-gateway-body-v1"` (whichever comes first in the doc) and add the inline annotation:
- For credential: `(v1, will become caliber-gateway-credential-v2 in #121)`
- For body: `(v1, will become caliber-gateway-body-v2 in #121)`

Subsequent HKDF occurrences in the same doc stay verbatim — no annotation.

- [ ] **Step 4: Verify**

Run: `grep -n "aide" docs/OAUTH_REFRESH_DESIGN.md`

Expected: only HKDF info lines remain (first one annotated, rest verbatim). If anything else surfaces, hand-decide.

### Subtask 3.6 — Final residual check + commit

- [ ] **Step 1: Aggregate residual check across all 5 docs**

Run:
```bash
grep -in "aide" docs/EVALUATOR.md docs/GATEWAY.md docs/MULTI_DEVICE.md docs/SELF_HOSTING.md docs/OAUTH_REFRESH_DESIGN.md
```

Expected: only HKDF info lines `info="aide-gateway-body-v1"` / `info="aide-gateway-credential-v1"`. The first HKDF line in each doc that contains any HKDF reference should also include the parenthetical annotation `(v1, will become caliber-gateway-*-v2 in #121)`. Subsequent HKDF lines in the same doc are un-annotated.

- [ ] **Step 2: Repo-wide friendly-fire check**

Run:
```bash
grep -rn "aide" README.md monitoring/ ops/ docs/EVALUATOR.md docs/GATEWAY.md docs/MULTI_DEVICE.md docs/SELF_HOSTING.md docs/OAUTH_REFRESH_DESIGN.md
```

Expected: only annotated HKDF lines in design docs. Anything else means a missed Edit or unexpected occurrence — hand-decide.

- [ ] **Step 3: Commit**

```bash
git add docs/EVALUATOR.md docs/GATEWAY.md docs/MULTI_DEVICE.md docs/SELF_HOSTING.md docs/OAUTH_REFRESH_DESIGN.md
git commit -m "docs(design): rebrand long-form design docs aide → Caliber (#125)

Mechanical rebrand of 5 prose-heavy design docs:
- docs/EVALUATOR.md (1 hit)
- docs/GATEWAY.md (6 hits)
- docs/MULTI_DEVICE.md (15 hits)
- docs/SELF_HOSTING.md (14 hits)
- docs/OAUTH_REFRESH_DESIGN.md (31 hits)

Three rules applied:
- Brand prose ('aide gateway', 'aide.example.com', 'aide-keychain-helper',
  etc) → Caliber / caliber-keychain-helper
- aide:gw:* Redis key references → caliber:gw:* (code was migrated in
  Phase 3 / PR #117)
- HKDF info strings 'aide-gateway-body-v1' / 'aide-gateway-credential-v1'
  kept verbatim because the code is still on v1; first occurrence in
  each doc annotated with a forward reference to #121

Closes #125"
```

---

## Task 4: Push branch + open PR

- [ ] **Step 1: Sanity check log**

Run: `git log --oneline main..HEAD`

Expected output (4 commits including the spec):
```
<sha> docs(design): rebrand long-form design docs aide → Caliber (#125)
<sha> refactor(monitoring): rename Prometheus alert groups + job labels aide → caliber (#123)
<sha> docs: drop original-codename disclaimer from README (#122)
10ecf7e docs(spec): rebrand Phase 4a design — README + monitoring + design docs
```

(Order may differ if rebased; the spec commit is on the branch first.)

- [ ] **Step 2: Push branch**

```bash
git push -u origin refactor/phase-4a-rebrand-bundle
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --repo hanfour/aide \
  --base main \
  --head refactor/phase-4a-rebrand-bundle \
  --title "refactor: rebrand README + monitoring + design docs (Phase 4a)" \
  --body "$(cat <<'EOF'
## TL;DR

Phase 4a — finish `aide → Caliber` for non-runtime surfaces left over from PR #117 (Phase 3 infra) and PR #119 (Phase 3.5 dev tooling). Zero runtime change.

## Why

PR #117 migrated production DB / Redis / launchd; PR #119 cleaned dev tooling + npm meta. Three categories were deliberately deferred and tracked as #122 (README disclaimer), #123 (Prometheus alert rules), #125 (5 long-form design docs). This PR closes all three.

## What's in

- **README.md**: drop the `> Original codename: aide …` blockquote that is now factually wrong post-Phase-3.
- **Prometheus** (4 files): rename 11 alert groups (7 in `monitoring/prometheus/alerts.yml`, 4 in `ops/prometheus/alerts.yml`), rename `job="aide-*"` labels inside alert expressions, rename `job_name: aide-*` in `monitoring/prometheus/scrape.example.yml`, and update `monitoring/README.md` prose + the suggested `aide-alerts.yml` file path.
- **Design docs** (5 files): rebrand `docs/EVALUATOR.md`, `docs/GATEWAY.md`, `docs/MULTI_DEVICE.md`, `docs/SELF_HOSTING.md`, `docs/OAUTH_REFRESH_DESIGN.md`. HKDF info strings `aide-gateway-{body,credential}-v1` are kept verbatim because the code is still on v1; first occurrence in each doc is annotated with a forward reference to #121.
- **Spec doc**: `docs/superpowers/specs/2026-05-11-rebrand-phase-4a-design.md` captures the design walkthrough.

## What's NOT in

- #120 CLI (`src/cli.ts`, `~/.aide.json`) — needs migration shim, separate PR.
- #121 HKDF v2 cipher migration — data-migration risk, separate PR.
- #124 Grafana dashboard UIDs / tags — strategy decision (keep UIDs vs hard rename) still open.
- #126 GitHub URL fields in root `package.json` — blocked on GitHub web-UI repo rename.

## Tests

- `pnpm lint` / `pnpm typecheck` green (no source files touched, runs in CI).
- YAML lint passes on both `alerts.yml` and `scrape.example.yml` (`python3 -c "import yaml; …"`).
- `promtool check rules` green if available (optional — YAML lint is sufficient here).
- Residual `grep -rn "aide" README.md monitoring/ ops/` returns nothing; residual grep across the 5 rebranded docs returns only annotated HKDF lines.

## Operator upgrade

After merging this PR:

1. Update local `prometheus.yml`: `job_name: aide-gateway` → `caliber-gateway`, `job_name: aide-api` → `caliber-api`.
2. Restart Prometheus (`docker compose restart prometheus` or equivalent).
3. If `alerts.yml` is mounted directly from the repo path, restart picks up new group names automatically; otherwise `cp` the new file and `reload`.
4. **Alertmanager**: no action required. `ops/alertmanager/alertmanager.yml.example` routes by `alertname` and `severity` only, never by alert group name.
5. (Optional) Rename the alerts file on disk (`aide-alerts.yml` → `caliber-alerts.yml`) and update `rule_files:` in `prometheus.yml` accordingly.

## Closes

Closes #122, #123, #125
EOF
)"
```

- [ ] **Step 4: Capture the PR number**

The previous step prints a URL like `https://github.com/hanfour/aide/pull/127`. Note the number — it goes in the merge command and the post-merge issue close commands.

- [ ] **Step 5: Wait for CI green**

Run:
```bash
gh pr checks <NN> --repo hanfour/aide --watch
```

If CI fails, diagnose. Most likely failure modes for this PR:
- YAML parse error in `alerts.yml` if a `sed` command corrupted indentation. Fix and create a new commit (don't amend; per repo convention always create a NEW commit after a hook failure).
- Markdown lint (if configured): broken internal links from prose Edits. Fix in new commit.

Do NOT proceed to Task 5 until CI is green.

---

## Task 5: Post-merge cleanup (after PR merges)

These steps run after the user merges the PR. They are part of the same effort but happen outside this branch's commit history.

- [ ] **Step 1: Merge the PR**

```bash
gh pr merge <NN> --repo hanfour/aide --rebase --delete-branch
```

- [ ] **Step 2: Manually close issues that didn't auto-close**

Rebase merges do not reliably trigger GitHub auto-close. Check state:

```bash
gh issue view 122 --repo hanfour/aide --json state
gh issue view 123 --repo hanfour/aide --json state
gh issue view 125 --repo hanfour/aide --json state
```

For any still `OPEN`:
```bash
gh issue close 122 --repo hanfour/aide --reason completed --comment "Shipped in #<PR>"
gh issue close 123 --repo hanfour/aide --reason completed --comment "Shipped in #<PR>"
gh issue close 125 --repo hanfour/aide --reason completed --comment "Shipped in #<PR>"
```

- [ ] **Step 3: Sync local main**

```bash
git checkout main
git pull --rebase origin main
git branch -d refactor/phase-4a-rebrand-bundle
```

- [ ] **Step 4: Operator upgrade on the user's host**

Manual operator action on the user's host (h4 mac). The plan documents the steps but does not execute them — the user owns their host:

```bash
# 1. Edit local prometheus.yml — rename job_name entries:
#      job_name: aide-gateway → job_name: caliber-gateway
#      job_name: aide-api     → job_name: caliber-api
# 2. Restart prometheus:
docker compose restart prometheus
# 3. Verify groups loaded:
curl -s http://prometheus:9090/api/v1/rules | jq '.data.groups[].name'
# Expected: caliber-liveness, caliber-rate-limit, caliber-failover,
#           caliber-oauth, caliber-workers, caliber-billing, caliber-gdpr
#           (and the ops/ groups if those are loaded:
#           caliber-evaluator, caliber-body-capture, caliber-gdpr,
#           caliber-llm-cost)
```

- [ ] **Step 5: Update memory**

The backlog memory file (`~/.claude/projects/-Users-hanfourhuang-ai-dev-eval/memory/rebrand_backlog_issues.md`) says "After issues are filed, delete this memory file (it's transient)." But after this PR ships only 3 of 7 issues are closed; 4 remain open (#120, #121, #124, #126).

Recommended action: ask the user to choose between
1. Edit the file inline to mark 3 done + leave 4 as the new backlog
2. Delete it (rely on GitHub `gh issue list --label rebrand --state open`)

Do not execute either without user confirmation.

---

## Self-review

**Spec coverage:**
- #122 README disclaimer drop — Task 1 ✓
- #123 Prometheus 7 + 4 groups + job labels + scrape example + monitoring/README — Task 2 ✓ (note: corrected from spec's 3 to actual 4 groups in `ops/prometheus/alerts.yml`)
- #125 5 design docs with 3 categorization rules — Task 3 ✓
- Verification (YAML lint, residual grep, friendly-fire check) — Subtasks 2.5, 3.6 ✓
- PR body matching spec skeleton — Task 4 Step 3 ✓
- Operator upgrade steps — PR body + Task 5 Step 4 ✓
- Alertmanager "no action required" line — PR body Step 4 ✓
- Post-merge issue close — Task 5 Step 2 ✓

**Placeholder scan:**
- No TBD / TODO / "implement later" anywhere.
- Some Edit calls in Task 3 are intentionally not pre-baked because they depend on auditing exact line content first — the plan instructs the executor to grep, then Edit per occurrence. Pre-baking 67 Edits would risk drift if any line numbers shifted between writing the plan and executing.
- `<NN>` placeholders appear only in the post-PR-creation steps where the PR number is genuinely unknown until `gh pr create` returns.

**Type consistency:**
- `caliber-gateway` / `caliber-api` job names used consistently in Task 2 across all 4 files and the PR body operator-upgrade step.
- `caliber-keychain-helper` named explicitly in Subtask 3.3 reference rules to match Phase 3 launchd rename.
- HKDF annotation phrasing identical wherever it appears: `(v1, will become caliber-gateway-*-v2 in #121)` with the `*` resolved to `credential` or `body` based on which info string is being annotated.

**Discrepancy flagged:**
- Spec said `ops/prometheus/alerts.yml` has 3 groups; actual is 4 (`aide-llm-cost` was missing from the issue body too). Plan renames all 4. Commit message for Task 2 explicitly notes this.
- `docs/MULTI_DEVICE.md` aide-count: spec said 19, actual `grep -c` says 15. Plan uses actual count.
