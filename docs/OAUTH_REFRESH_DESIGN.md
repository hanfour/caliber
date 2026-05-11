# OAuth refresh design — long-term fix for anthropic Claude Max

> Status: design proposal, not implemented. Decision pending; once a
> direction is picked, the chosen option becomes a multi-PR roadmap.

## Problem statement

caliber gateway runs in a Docker container on a host machine. The same
host typically also runs the anthropic Claude Code desktop app or CLI,
authenticated against the same Claude Max subscription. Both processes
share a single OAuth grant that lives in macOS Keychain under the
entry `Claude Code-credentials`.

Anthropic's OAuth token endpoint
(`https://console.anthropic.com/v1/oauth/token`) implements **refresh
token rotation**: every successful `grant_type=refresh_token` exchange
returns a new access_token *and* a new refresh_token, invalidating
the previous refresh_token immediately.

This produces a hard race:

1. caliber reads the bundle from Keychain at onboard time and stores it
   in `credential_vault` (encrypted with `CREDENTIAL_ENCRYPTION_KEY`).
2. caliber's background cron + inline refresh path (in
   `apps/gateway/src/runtime/oauthRefresh.ts` and
   `apps/gateway/src/workers/oauthRefreshCron.ts`) refresh
   independently of Keychain.
3. Claude Code app on the same host refreshes from Keychain on its
   own schedule, writing the new token *back* to Keychain.
4. Whichever side refreshes first invalidates the other's stored
   refresh_token. The loser starts getting `400 invalid_grant` from
   anthropic; caliber's `recordFailure` flow then increments
   `oauth_refresh_fail_count` and after 3 strikes the account flips
   to `schedulable=false`.

Plus a secondary failure mode: caliber's per-request inline refresh
fires on *every* request inside the leading window
(`GATEWAY_OAUTH_REFRESH_LEAD_MIN`, default 10 min). When something
goes wrong (wrong endpoint, lost refresh_token, anthropic 5xx),
this hammers anthropic with retries → quickly trips upstream rate
limits → the recovery path itself gets `429 rate_limit_error` →
deadlock until the rate limit bucket refills (~15 minutes).

Both failure modes have been observed live during multi-device
self-hosted use. Neither is safe to ship to other operators.

## Constraints

- Anthropic OAuth refresh tokens **rotate on every use** — not
  configurable.
- Anthropic OAuth refresh window is short (~hours, not days).
- caliber runs in Docker, not on the host directly — direct Keychain
  write requires either a host-side helper, a volume mount of an
  exported keychain item, or some IPC bridge.
- macOS Keychain is macOS-only. Linux operators use libsecret or
  similar; Windows uses DPAPI. A solution that "writes back to
  Keychain" doesn't generalize without per-OS adapters.
- The OAuth grant belongs to a single human user with a single
  Claude Max subscription. Anthropic reserves the right to flag
  multi-device sharing as ToS-adjacent (private Slack chatter, no
  formal policy).
- Operators want zero-touch operation past initial onboard. Manual
  re-onboard every few days is unacceptable.

## Options

### A. caliber refreshes, writes new bundle back to Keychain

When caliber successfully refreshes, persist the new bundle to **both**
DB and Keychain. Claude Code app reads Keychain on every start and
will pick up the rotated token transparently.

**Pros**
- Single source of truth (Keychain), caliber stays authoritative for
  refresh.
- Zero behavior change for Claude Code app on host.

**Cons**
- caliber runs in Docker; writing to host Keychain requires a host-side
  helper (e.g. unix socket + small daemon doing `security
  add-generic-password -U` on caliber's behalf), OR running caliber outside
  Docker on the host.
- macOS-only. Linux operators get nothing from this path.
- Race window: between caliber's refresh-then-write, if Claude Code app
  refreshes against the in-flight old token it still 400s.
- Permission UX: macOS Keychain prompts the user to authorize each
  modifying access unless `-A` is used at create time, which has its
  own security implications.

**Complexity**: medium-high. ~1 week of focused work for a robust
implementation including the host-side helper, signature/ACL
handling, and tests.

### B. Lazy refresh: caliber only refreshes on 401, never proactively

Rip out the cron + lead-window inline refresh entirely. Send every
request with the currently stored access_token; if anthropic returns
401, *then* attempt refresh (single attempt, no retry). On refresh
success, retry the original request once. On refresh failure, return
the upstream error to the client.

**Pros**
- Drastically reduces refresh frequency: one refresh per access_token
  expiry (~hourly) vs. potentially per-request.
- No hammering upstream during failure — single attempt then bail.
- Makes Claude Code app the de-facto active refresher (because user
  uses Claude Code app more frequently than caliber); caliber naturally
  inherits the new tokens via Keychain re-read on its lazy refresh.
- No host-side changes required.

**Cons**
- Still races with Claude Code app on the actual refresh call (both
  could 401 within a 1-second window and both try).
- Adds latency on the first request after token expiry (refresh +
  retry round-trip).
- Requires re-reading from Keychain into DB on each lazy refresh
  (sync once at onboard then drift).

**Variant B-prime**: lazy refresh + Keychain re-read before each
refresh attempt. If Keychain has a newer access_token (different
from DB), use that without calling anthropic at all. Only call
anthropic when even Keychain's token is stale.

**Complexity**: medium. ~3-4 days. Bulk of work is restructuring
inline-refresh in `withSlotAndCredential` and routes' attempt
callbacks; Keychain reader is small.

### C. Independent OAuth grant for caliber

User runs a caliber-side OAuth flow (separate from `claude login`),
producing a refresh_token that *only* caliber ever uses. Claude Code app
on the same host keeps using its own Keychain bundle, untouched.

**Pros**
- Complete decoupling. No race ever.
- Predictable refresh behavior.
- Works across hosts.

**Cons**
- Anthropic's OAuth endpoint requires a registered client_id;
  currently caliber piggybacks on Claude Code's public client_id
  (`9d1c250a-…`). Whether anthropic permits a *second* concurrent
  grant per user against this client is unverified — possibly fine,
  possibly counts toward a per-user grant quota.
- User has to do a second login flow, including the device-code
  exchange. UX cost.
- Some self-host operators run caliber on a server with no browser →
  device-code flow needs a workable path.
- Doesn't help operators who *want* caliber to share Claude Code's
  grant (e.g. they only have one Claude Code session and want
  programmatic access via caliber too).

**Complexity**: medium-high. ~1 week including the device-code
flow UI in the admin dashboard, ToS clarification with anthropic
(arms-length) about multi-grant behavior, and migration from
shared-grant accounts.

### D. Keychain as the only source of truth (no DB cache)

caliber reads the bundle from Keychain on every request via a host
volume mount + a tiny FUSE-style read helper, OR via a host-side
unix-socket daemon. caliber never stores the bundle in `credential_vault`
for type=keychain; the column would be a `path` reference rather than
encrypted ciphertext.

**Pros**
- caliber and Claude Code app are guaranteed to see the same token —
  no possible race.
- caliber doesn't need to refresh at all (only reads).
- Tokens never get persisted unencrypted in caliber's DB.

**Cons**
- macOS-specific without per-OS adapters.
- Cross-process FS access to Keychain is non-trivial — Keychain
  isn't a flat file. Requires a host-side helper (same complexity
  as option A's writer, but read-only).
- Removes caliber's ability to centrally manage OAuth lifecycle (audit,
  rotation visibility, etc.).
- Per-request Keychain access has measurable latency and triggers
  user prompts unless ACL is pre-configured.

**Complexity**: high. ~1.5-2 weeks including the host helper, test
infra, and per-OS adapters if multi-platform from day one.

### E. Better failure semantics on top of current design (defensive, not curative)

Don't change the architecture; just stop the bleeding when refresh
fails:

1. Detect `429 rate_limit_error` from anthropic OAuth endpoint and
   apply exponential backoff *before* incrementing `fail_count`.
   Don't trip the auto-pause heuristic on transient upstream errors.
2. On `400 invalid_grant`, immediately auto-pause and surface a
   prominent admin UI banner asking the operator to re-onboard,
   with one-click re-onboard from Keychain.
3. Cron tick rate: drop from 1 min to 5-10 min when there are no
   accounts in the lead window. Add jitter.
4. Inline refresh: gate behind a per-account refresh-recently lock
   (e.g. "don't try refresh again for 60s after a failure").

**Pros**
- Small, contained changes — no architectural shift.
- Buys time and reduces operator pain even before A/B/C/D ships.
- Compatible with any of A/B/C/D as a follow-up.

**Cons**
- Doesn't fix the underlying race; just makes its symptoms less
  severe.
- Still requires periodic operator intervention (re-onboard) when
  Claude Code app + caliber collide.

**Complexity**: low. ~1-2 days.

### F. Use anthropic API key (sk-ant-…) instead of OAuth

Skip OAuth entirely; use a long-lived API key from
console.anthropic.com.

**Pros**
- No refresh, no rotation, no race.
- Simplest possible auth model.

**Cons**
- Charges per-token against the API key's billing entity, **not**
  the user's Claude Max subscription. The whole point of the OAuth
  path is to consume Claude Max quota for free; switching to API
  key costs real money.
- Some operators don't have an API key budget.

**Complexity**: trivial — already supported by caliber. Just an
operator UX change.

## Recommended path

**Phase 1 (immediate, this PR cycle)**: implement option E. Surface
better diagnostics, prevent the rate-limit-feedback-loop, and add an
admin UI re-onboard button so operators can recover with one click
instead of running a hand-crafted SQL script.

**Phase 2 (next milestone)**: implement option B (lazy refresh, with
the B-prime Keychain re-read variant). Removes the proactive refresh
problem at the root and makes caliber a "follower" of Claude Code app's
refresh cadence.

**Phase 3 (if user demand justifies)**: option A or D (Keychain
write-back / Keychain-as-source-of-truth) for the operators who want
caliber to be the active refresher rather than the follower.

Option C (independent OAuth grant) parked unless we can verify
anthropic permits multi-grant per user without ToS issues.

Option F (API key) documented as an explicit alternative path for
operators who prefer a paid-billing model.

## Open questions

1. Does anthropic publish refresh_token rotation behavior anywhere?
   (Currently inferred from observation.)
2. Is the public client_id `9d1c250a-…` documented or just observed?
   If observed, anthropic could revoke / change without notice.
3. What's the actual access_token TTL? (Observed 13:01 → 13:01 next
   day = ~24h, but unverified across model variants.)
4. Does the `oauth-2025-04-20` anthropic-beta header value affect
   refresh behavior, or only message API behavior?
5. Per-user concurrent OAuth grant limit — if any?

These should be answered (via experimentation or anthropic dev
relations) before committing to phase 2 or beyond.

## Migration / compatibility

Whatever direction we pick:

- Existing OAuth accounts on operators' deployments must keep
  working through the upgrade. No forced re-onboard.
- The `type` enum on `upstream_accounts` may grow new values
  (`keychain`, `oauth_independent`) — purely additive, no migration
  for existing rows.
- Admin UI needs a clear visual signal for which auth mode each
  account uses, so operators can debug.
- `docs/GETTING_STARTED.md` Part 2 needs revision once a path is
  picked — currently it walks users through the (now known
  problematic) shared-grant onboard.

## Decision log

(Empty — to be filled in as phases are picked up.)
