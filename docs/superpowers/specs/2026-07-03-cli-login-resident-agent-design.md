# CLI Login + Resident Agent (`caliber login`) — Design Spec

- **Date:** 2026-07-03
- **Status:** Design approved (brainstorming) → ready for implementation plan
- **Builds on:** the existing device/ingest pipeline (`agent/` Go daemon, `/v1/ingest`, `devices` + `deviceEnrollmentTokens` + `deviceApiKeys` schema, `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md`, phase-2 PR1–PR4 specs) and the published npm CLI `@hanfour.huang/caliber` (root `src/`, local analyzer).
- **Provenance:** Decisions fixed via brainstorming with the operator, grounded in a codebase survey of the existing device/client-events subsystem.

## Fixed decisions (operator-chosen — do not re-litigate)

1. **Collection mechanism = periodic local-log harvesting** (the existing Go agent tailers over `~/.claude/projects/` and `~/.codex/sessions/`). NO local traffic proxy, NO interception of CLI network calls, NO change to gateway routing.
2. **Data scope = full conversation content** (`redaction_mode: full-body`). Client-side mandatory secret-scrub still applies (server default patterns + org custom patterns via `GET /v1/redaction-set` — all existing).
3. **Login = OAuth-style Device Code Flow.** `caliber login` prints a short user code, opens the browser to the dashboard; the member approves; the CLI polls until approved. Works headless (SSH) by manual code entry.
4. **Single entry point = the TS `caliber` CLI** (npm `@hanfour.huang/caliber`). `caliber login` downloads the platform-matched Go agent binary (GitHub Releases + sha256 verification) and manages it. Members never invoke `caliber-agent` directly.
5. **Platform scope v1 = macOS (launchd LaunchAgent).** Linux: documented `caliber agent run` foreground fallback; systemd user unit is a follow-up. Windows: out of scope.
6. **Server-pushed agent config, v1 = polling interval only** (org-level, 30 s–30 min, set in the dashboard, fetched hourly by the agent). Scheduled upload windows are explicitly deferred (see §9).
7. **First-login backfill = the past 90 days** (operator-revised from "full history", 2026-07-03). The watcher gains an mtime-based discovery filter anchored at enroll time (§5.5). Throttled by the existing 16 MiB/file/tick budget.
8. **Watch-all by default.** `caliber login` enrolls with the full `~/.claude/projects/` + `~/.codex/sessions/` roots watched (this deliberately flips the agent's original empty-by-default privacy contract; consent moves to the login approval page, §6).

---

## 0. Summary

Members run `npm i -g @hanfour.huang/caliber && caliber login`. The CLI performs a device-code authorization against `caliber.miilink.net`, receives a one-time enrollment token, downloads the Go `caliber-agent` binary, enrolls non-interactively (watch-all, full-body), installs a launchd LaunchAgent, and from then on every Claude Code / Codex conversation on that machine is harvested incrementally (60 s default tick, org-configurable from the dashboard) and uploaded to `POST /v1/ingest`.

**~85% of the pipeline already exists and is untouched:** ingest endpoint (idempotent dedup, gzip, tenant guard), `client_sessions`/`client_events` (monthly partitions), device registry + `cda_*` keys + revocation, redaction-set distribution, the Go watcher/chunker/sink, and `/dashboard/devices`. This project is productization: login UX, residency, defaults, and one config-push endpoint.

## 1. What exists today (verified)

| Piece | Location | State |
| --- | --- | --- |
| Enrollment token issue (dashboard, 1 h TTL, HMAC-stored) | `apps/api/src/trpc/routers/devices.ts` | ✅ ship |
| `POST /v1/devices/enroll` (token → device + `cda_*` key, transactional, single-use) | `apps/api/src/rest/devicesEnroll.ts` | ✅ ship |
| `POST /v1/ingest` (Bearer `cda_*`, gzip, idempotent, tenant-guarded, 1000-row batches) | `apps/api/src/rest/ingest.ts` | ✅ ship |
| `GET /v1/redaction-set` (org patterns or 11 server defaults, 24 h TTL) | `apps/api/src/rest/redactionSet.ts` | ✅ ship |
| `DELETE /v1/devices/me` (self-revoke, idempotent) | `apps/api/src/rest/devicesRevokeSelf.ts` | ✅ ship |
| Go agent: `enroll` (interactive wizard), `run` (foreground, 60 s tick), claude+codex watchers, watermark state, 16 MiB/file/tick budget, ~1 MiB chunks, gzip sink w/ backoff, 3 redaction modes, `pause/resume/add-path/remove-path/status/uninstall` | `agent/` | ✅ ship (PR4) |
| `/dashboard/devices` (list, revoke, enrollment-token dialog + curl one-liner) | `apps/web/src/components/devices/` | ✅ ship |
| TS `caliber` CLI (local analyzer only — `config/report/monthly/quarterly/summary/init-standard`; zero network/auth code) | root `src/` | ✅ ship (npm 0.1.2) |

**Gaps this spec closes:** (a) no `login` — enrollment requires a dashboard-issued token pasted into a separate binary; (b) no residency — `caliber-agent run` is foreground-only; (c) watch paths default to empty; (d) no server-pushed agent behavior config; (e) no binary distribution channel for the Go agent.

## 2. Component 1 — Device Code Flow (server)

New REST endpoints in `apps/api/src/rest/` (same style as existing device REST; NOT tRPC — the CLI is unauthenticated at this point):

- **`POST /v1/device-auth/start`** (public, rate-limited): body `{hostname, os, agent_version, cli_version}`. Creates flow state in **Redis** (`device-auth:<device_code_hash>`, TTL 15 min — mirrors the oauth-flow state pattern; **zero DB schema**). Returns `{device_code, user_code, verification_uri, verification_uri_complete, interval: 5, expires_in: 900}`.
  - `device_code`: ≥128-bit random, stored only as SHA-256 hash key.
  - `user_code`: 8 chars, `XXXX-XXXX`, unambiguous alphabet (no 0/O/1/I), a secondary Redis index `device-auth:code:<user_code>` → device_code hash.
- **Web approval page `/device`** (session-authenticated, i18n 5 catalogs): accepts `?code=` prefill or manual entry; shows the requesting device (hostname/os) + the **consent copy** (§6); on approve → resolves the member's org (same earliest-membership rule as `devices.enrollmentToken.issue`), issues a standard **enrollment token** via the existing issue path, stores it (encrypted at rest is unnecessary — 15 min TTL, single-use) in the flow state, marks flow `approved`, writes an audit-log entry. A deny button marks `denied`.
- **`POST /v1/device-auth/poll`** (public, rate-limited): body `{device_code}`. Responses follow RFC 8628 semantics: `authorization_pending` / `slow_down` / `expired_token` / `access_denied` / success `{enrollment_token}`. Success **deletes the flow state** (single collection).

Then the CLI redeems the enrollment token through the **unchanged** `POST /v1/devices/enroll`. No new credential type; `devices`/`deviceApiKeys`/revocation/audit are reused as-is.

Anti-abuse: `start` and `poll` share the api rate-limit plugin with dedicated buckets; user-code approval attempts are limited per session; flow state is single-approve (approve on an already-approved/denied flow → 409).

## 3. Component 2 — Server-pushed agent config

- **`GET /v1/agent-config`** (Bearer `cda_*`, same auth helper as `/v1/redaction-set`): returns `{poll_interval_seconds}` (org-level; default 60, clamp 30–1800).
- **Storage:** new nullable column `organizations.agent_poll_interval_seconds` (single migration; a settings-jsonb is overkill for one knob — revisit if a second knob lands).
- **Dashboard UI:** a small "Agent 設定" card on `/dashboard/devices` (org-admin only): interval field with the clamp, description of the freshness trade-off.
- **Agent side:** fetch at `run` startup + hourly refresh; on fetch failure use last-cached value, then the local `--interval` flag, then 60 s. Server value **wins over** the local flag (the flag is demoted to a debug override applied only when the server is unreachable and no cache exists).

## 4. Component 3 — TS `caliber` CLI (root `src/`, new commands)

New commands (commander, matching existing CLI style):

- **`caliber login [--server URL]`** — the whole onboarding, idempotent:
  1. Device-code flow (§2): print `user_code` + open browser (`verification_uri_complete`); poll.
  2. Download the platform-matched `caliber-agent` binary from GitHub Releases (version pinned by the CLI, see §5.3) to `~/.caliber/bin/caliber-agent`; verify sha256 against the release checksums file; refuse on mismatch.
  3. `caliber-agent enroll --token <t> --server <URL> --watch-all --mode full-body` (non-interactive, §5.1).
  4. `caliber-agent install-service` (launchd, §5.2) — on non-macOS, print the documented foreground fallback instead.
  5. Print a success summary: device name, watched roots, redaction mode, dashboard URL, and the 90-day-backfill notice.
- **`caliber logout`** — `uninstall-service` → `caliber-agent uninstall` (self-revoke + keychain + state cleanup, existing) → remove `~/.caliber/bin` + login state.
- **`caliber agent status|pause|resume`** — thin passthroughs to the Go binary (members can pause any time).
- **Config:** `~/.caliber/cli.json` `{serverUrl, agentVersion, binaryPath}` — **no secrets** (the `cda_*` key stays in the agent's keychain, unchanged).
- Errors: every network step has a user-facing message + retry hint; login is resumable (re-run restarts cleanly; enroll of an already-enrolled machine reuses `caliber-agent status` to detect and short-circuit).

## 5. Component 4 — Go agent additions

1. **Non-interactive enroll:** flags `--token`, `--server`, `--watch-all`, `--mode` on `enroll`; `--watch-all` writes the two roots (`~/.claude/projects`, `~/.codex/sessions`) into the watch config the wizard would otherwise ask about. The interactive wizard remains for standalone use.
2. **`install-service` / `uninstall-service`:** write/remove `~/Library/LaunchAgents/net.miilink.caliber-agent.plist` (`KeepAlive`, `RunAtLoad`, program = the installed binary with `run`), `launchctl bootstrap/bootout gui/$UID`. Logs to `~/.caliber-agent/agent.log` (already the agent's home).
3. **Release pipeline:** new CI workflow builds `darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64` + `checksums.txt`, attached to a `agent-vX.Y.Z` GitHub Release. The TS CLI pins the compatible agent version (a constant bumped per CLI release).
4. **Hourly config refresh** (§3) inside the `run` loop.
5. **90-day backfill filter:** `enroll` computes and persists `backfill_cutoff = enrolledAt − 90d` in the agent config (a fixed anchor, NOT rolling — so the watched window never silently shrinks). At discovery time, files with `mtime < backfill_cutoff` are skipped; once a file is watched (or its mtime moves past the cutoff, i.e. an old session gets new activity), it is tailed from offset 0 as today — meaning a revived old session uploads its full content, which is acceptable ("still-active sessions are in scope"). Flag `--backfill-days` (default 90) on `enroll` for future flexibility; `0` = from-now-only.

Backfill note: the 16 MiB/file/tick budget spreads the 90-day history over hours of background ticks; server-side dedup makes interruptions safe. The login summary states the 90-day window.

## 6. Data contract, consent, transparency

- Default mode **`full-body`**: full message content uploaded; the client-side secret-scrub is mandatory and non-disableable (existing `agent/redact/`); org custom patterns apply (existing).
- **Consent = the approval page.** `/device` displays, before the approve button: what is collected (full Claude Code / Codex conversation content on that machine, secret-scrubbed), where it goes (the org on `caliber.miilink.net`), that it includes the past 90 days of history, and the member's controls (`caliber agent pause`, device revocation in the dashboard, GDPR delete — all existing). Approving is the informed opt-in; nothing is collected before it.
- Member visibility: `/dashboard/devices` (own devices, revoke) exists; own ingested activity is visible through existing own-scope dashboards.

## 7. Ops notes (deploy-time, not code)

- **VPS disk sizing:** 11 members × 90-day transcripts land in `client_events` (monthly partitions). Before team rollout, estimate from 2–3 pilot members' last-90-day `~/.claude` + `~/.codex` sizes and check Vultr disk headroom; ingest volume is observable via the devices page (`lastSeenAt`) and DB partition sizes.
- Rate-limit buckets for `/v1/device-auth/*` need prod env review (shared-IP concern does not apply — these come from members' machines directly).

## 8. Testing

- **api integration (testcontainers):** device-auth happy path (start → approve → poll → enroll), TTL expiry, single-use poll, deny, cross-org isolation (approver's org binds the device), user-code brute-force rate limit, `agent-config` clamp + auth.
- **TS CLI unit:** login state machine against a mock server (pending → slow_down → approved), checksum verification (tampered binary refused), idempotent re-login.
- **Go:** non-interactive enroll flag matrix, plist generation golden-file, config-refresh fallback chain (server → cache → flag → default), backfill filter (file older than cutoff skipped; file crossing the cutoff via fresh mtime picked up; `--backfill-days 0` starts empty; anchor is fixed at enroll, not rolling).
- **E2E (compose):** api up → scripted login (poll loop, no real browser: approve via direct API call with a session) → feed a fixture transcript into a temp `~/.claude` → assert `client_sessions`/`client_events` rows.

## 9. Future extensions (explicitly deferred)

- Scheduled upload windows (batch mode) — deferred until a real need (e.g. constrained networks); design placeholder: extra fields on `/v1/agent-config`.
- systemd user unit for Linux; Windows support.
- Per-device (not just org) interval override.
- Backfill window other than 90 days exposed to members (the `--backfill-days` flag exists but `caliber login` does not surface it in v1).

## 10. Out of scope

- Any local proxy / traffic interception; any change to gateway routing or BYOK flows.
- Changes to the ingest pipeline, `client_events` schema, redaction engine, or the evaluator.
- Replacing the enrollment-token dialog on `/dashboard/devices` (it remains for manual/headless enrollment).
