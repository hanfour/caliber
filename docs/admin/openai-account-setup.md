# OpenAI account onboarding

This guide is for org admins onboarding an OpenAI upstream account into
the gateway pool.  The supported path is a **project API key**
(`sk-...` / `sk-proj-...`) issued from a compliant OpenAI organization.

## Why API key, not OAuth

The Caliber gateway routes traffic from many internal users through a
shared pool of upstream accounts.  For OpenAI, that licensed pattern is
the **OpenAI Platform API** — programmatic, post-paid by token, no
per-user subscription.  ChatGPT consumer-subscription OAuth tokens are
not an exposed onboarding path here; see
[`../../.claude/plans/2026-05-04-api-key-migration-plan.md`](../../.claude/plans/2026-05-04-api-key-migration-plan.md)
for the architectural rationale.

Anthropic accounts still support both `api_key` and `oauth` paste paths;
this guide covers the OpenAI side only.

## 1 — Provision an OpenAI org / project

If your organization doesn't already have an OpenAI Platform org:

1. Sign in at <https://platform.openai.com/> with the email you want to
   manage billing under (separate from `chat.openai.com` consumer
   subscriptions).
2. Create the organization, complete billing setup, set an org-level
   monthly spend cap.

Inside the org, create a **project** for this gateway deployment:

1. <https://platform.openai.com/settings/organization/projects> →
   **+ Create project**.
2. Name it after the gateway environment (e.g. `caliber-prod`,
   `caliber-staging`) so spend reports map cleanly.
3. Set a per-project monthly spend cap below the org cap — first line
   of defence against runaway clients.
4. Limit the model lineup to what the gateway actually serves
   (`Project settings → Limits`).  Removing models you don't use shrinks
   the blast radius if the key leaks.

## 2 — Mint a project API key

1. From the project page → **API keys** → **+ Create new secret key**.
2. **Owned by**: pick `Service account` if your plan exposes it,
   otherwise the project owner user.  Service-account keys survive
   personnel changes.
3. **Permissions**: scope down where possible — at minimum revoke
   write access to admin endpoints.  The gateway only needs inference
   permissions.
4. Copy the `sk-proj-...` value once — OpenAI does not show it again.

If your org plan supports it, prefer **multiple smaller-scoped project
keys** over one big key — the gateway's `accountGroups` already
load-balances across multiple `upstream_accounts` rows under one group
(see [`GATEWAY.md`](../GATEWAY.md) §account groups).

## 3 — Onboard into the gateway

In the admin UI:

1. Navigate to `Dashboard → Organizations → <your org> → Accounts → New`.
2. Fields:
   - **Name** — descriptive, e.g. `OpenAI prod / project caliber-prod`.
   - **Platform** — `OpenAI`.
   - **Type** — `API key` (the `OAuth (JSON)` option is greyed out for
     OpenAI; that path is intentionally not exposed).
   - **Scope** — `Organization` makes the account available to every
     team in the workspace; `Specific team` restricts it.
   - **Credentials** — paste the `sk-proj-...` value verbatim, no
     wrapping JSON, no prefix.
3. Submit.  The credential is encrypted (`encryptCredential`,
   AES-GCM) and stored in `credential_vault`; the raw key is not
   logged or returned by any subsequent read.

The first request that routes to this account validates the key
upstream — a typo / revoked key surfaces as a 401 from the gateway
back to the client.

## 4 — Operational hygiene

**Rotate on schedule** — quarterly is a good default.  Mint a new key,
add it as a second `upstream_account`, drain traffic by lowering
priority on the old one in `accountGroups`, then revoke the old key on
OpenAI's side.

**Watch spend** — set OpenAI-side per-project caps.  The gateway's
`quotaUsd` per-apiKey limit is a separate per-internal-user bound; the
two layers should align (gateway caps ≤ project cap ≤ org cap).

**Revoke immediately on suspected leak**.  Revocation on
`platform.openai.com` is instant — subsequent gateway requests will
401.  Replace by minting a new key and updating the upstream_account
via `accounts.rotate`.

**Audit access** — `usage_logs` (gateway) records every routed
request; OpenAI's project-level usage feed is the source of truth for
billed spend.  Reconciliation between the two is part of the Phase 3
work in the migration plan.

## 5 — Multi-account pool (optional)

If you want to spread load across multiple project keys (e.g. separate
spend buckets per business unit), create one `upstream_account` per key
and group them with `accountGroups` for the same scope.  The scheduler
honours `priority` and `rate_multiplier`; nothing else is needed at
the runtime layer.

This is the compliant version of the brainstormed "#1 account pool" —
the keys are independent compliant credentials owned by the same
billing entity, not aggregated consumer subscriptions.

## 6 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 on first request | typo in pasted key, or key was revoked between mint and paste | re-mint, re-paste |
| 429 on otherwise-light traffic | project / org spend cap exceeded, or model-level rate limit | raise cap on OpenAI side, or split traffic across multiple project keys |
| `model_not_found` | project's allowed-model list excludes the requested model | add the model to project limits |
| Gateway shows `oauth_invalid` for an api_key account | should not happen for `type: "api_key"` — this status is OAuth-only | check `accounts.get`; if it's stuck, delete and re-create the row |

## See also

- [`../GATEWAY.md`](../GATEWAY.md) — overall gateway architecture and
  admin runbook
- [`../../.claude/plans/2026-05-04-api-key-migration-plan.md`](../../.claude/plans/2026-05-04-api-key-migration-plan.md)
  — why the OAuth-pool path was abandoned and what's planned next
- ChatGPT Team / Enterprise admin API integration is Phase 2 of the
  migration plan; this guide will gain a sibling
  `chatgpt-team-setup.md` once that ships.
