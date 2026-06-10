# Model Alias Resolution — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorming) — ready for implementation plan
**Scope:** Caliber gateway — adaptive model resolution for Anthropic + OpenAI surfaces

## Problem

The gateway is a pure pass-through for the request `model` field. Clients that
send a stale or family/alias model id get a bare upstream `404` (e.g. a Claude
Max OAuth token rejects `claude-3-5-haiku-20241022` while accepting the current
`claude-haiku-4-5-20251001`). There is no model discovery, validation, or
resolution. We want the gateway to **adaptively resolve model aliases to the
current newest concrete id** so callers don't have to track exact dated ids.

Found during the 2026-06-10 Anthropic OAuth own→own verification: old model ids
404 on Claude Max; current ids work.

## Goal & Non-Goals

**Goal:** When a client sends a model *alias* (a `-latest` suffix or a bare
family name), the gateway resolves it to the newest concrete model id in that
family — sourced from a live, cached `/v1/models` list per platform — and
forwards the rewritten request. Explicit concrete ids are never touched.

**Non-Goals:**
- NOT auto-upgrading explicit concrete ids (no silent rewrite of what the client
  explicitly asked for — that would surprise clients on capability/price).
- NOT a model catalog/billing UI.
- NO schema change / migration (reuses `usage_logs.requested_model` /
  `upstream_model`).

## Decisions (from brainstorming)

| # | Decision |
|---|----------|
| Behavior | **Alias resolution only.** Concrete id == a known list entry → pass through unchanged. Alias → resolve to family-newest. |
| Alias forms | **Both**: `-latest` suffix (`claude-sonnet-latest`) **and** bare family name (`claude-sonnet`). |
| Platforms | **Both** Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`, `/v1/responses`). |
| List source | **Live fetch + in-memory cache (TTL ~1h) + static fallback.** Background-refreshed off the request path. |
| "Newest" | **Max `created` timestamp** from the list entry — NOT version-string parsing. |
| Unresolvable | **Pass through** (no new failure mode) — let the upstream respond. |
| Transparency | Log `requested_model`=alias + `upstream_model`=resolved (existing columns); add response header `x-caliber-resolved-model` when a resolution happened. |

## Core Resolution Flow

```
client body.model
  ├─ exactly matches a concrete id in the cached list  → pass through, untouched
  ├─ alias (`<family>-latest` OR bare `<family>`)
  │     → look up the platform's cached model list
  │     → pick the family member with the max `created` timestamp
  │     → rewrite body.model = resolved id; forward upstream
  │     → usage_logs: requested_model = alias, upstream_model = resolved id
  │     → response header x-caliber-resolved-model: <resolved id>
  └─ alias but no family match (or list empty)          → pass through (upstream answers)
```

Resolution runs in each route **after** the existing `body.model` non-empty
validation and **before** forwarding. `requestedModel` (used for usage logging)
is set to the *original* alias; the rewritten `body.model` carries the resolved
id to the upstream.

## Components (high cohesion, small files)

- `packages/gateway-core/src/models/resolveModelAlias.ts` — **pure function**,
  no I/O: `(requested: string, platform, list: ModelListEntry[]) → { resolved: string, wasAlias: boolean, family?: string }`.
  Holds all the family-matching + newest-by-created logic. Independently unit-testable.
- `packages/gateway-core/src/models/modelRegistry.ts` — cache + background
  refresh + credential selection for the fetch + static fallback constants.
  Exposes `getModelList(platform): ModelListEntry[]` (cache or fallback) and a
  refresh loop. The only I/O surface.
- gateway routes (`messages.ts`, `chatCompletions.ts`, `responses.ts`,
  `codexResponses.ts`) — call resolve after validation, rewrite `body.model`,
  set the response header, keep `requestedModel` = the alias.

`ModelListEntry = { id: string; created: number }`.

## Model Registry (source, cache, fallback)

- **Background refresh** (not on the request path → no per-request latency): a
  refresh loop every `MODEL_REGISTRY_REFRESH_SEC` (default 3600) fetches each
  platform's models endpoint and replaces the in-memory cache. In-memory per
  gateway instance (the list is eventually-consistent; no Redis needed).
- **Fetch credential:** the refresh job picks an active upstream for the
  platform and uses its vault-decrypted credential. Anthropic: prefer an
  `api_key` upstream, fall back to an `oauth` one. OpenAI: a codex upstream.
- **Static fallback:** a built-in `{ family → newest-known concrete id }` map
  (env-overridable via `MODEL_REGISTRY_FALLBACK_*`). Used on cold start /
  fetch failure / missing endpoint, so resolution keeps working and service is
  never interrupted. Fallback use emits a metric.

### Feasibility spike (FIRST step of the plan, before building)

Two endpoints must be verified live before relying on live fetch:
1. **Anthropic `GET /v1/models`** — does it accept a Claude Max **OAuth** token,
   or only an `api_key`? Determines which credential the refresh job uses for
   Anthropic.
2. **OpenAI via sub2api** — does `UPSTREAM_OPENAI_BASE_URL` (sub2api) expose
   `GET /v1/models`? If NOT, the OpenAI half degrades to **static-fallback-only**
   (still functional, just not live-refreshed). The Anthropic half is the
   higher-confidence live path.

The spike result decides per-platform whether live fetch or fallback-only is the
effective source. The design works either way (fallback is a first-class path).

## Resolution Semantics

**Concrete vs alias:** if `requested` exactly equals some `list[].id`, it's
concrete → pass through. Otherwise attempt alias resolution.

**Family prefix:**
- `-latest` suffix → strip `-latest`; the remainder is the family prefix.
- bare family name → the whole string is the family prefix.

**Family membership:**
- **Anthropic** (clean naming): family `claude-sonnet` → list ids starting with
  `claude-sonnet-`; pick max `created`. Same for `claude-haiku` / `claude-opus`.
- **OpenAI** (ambiguous naming, e.g. `gpt-5` vs `gpt-5-mini`): **conservative.**
  Only resolve when the family maps to a single unambiguous member set; require
  the char after the family prefix to begin a version/date segment, not another
  sub-model keyword (mini/nano/turbo/…). If the family can't be matched
  unambiguously → **pass through** (don't guess).

**Tie-breaks:** equal `created` → pick the lexicographically-greatest id
(deterministic). No family match / empty list → pass through.

## Observability

- Metrics: `gw_model_alias_resolved_total{platform,family}`,
  `gw_model_registry_fetch_total{platform,result}`,
  `gw_model_registry_fallback_used_total{platform}`.
- `usage_logs` already records `requested_model` (alias) vs `upstream_model`
  (resolved) — no schema change.
- Response header `x-caliber-resolved-model: <id>` only when a resolution
  occurred (transparency; clients learn what they actually got).

## Edge Cases

- Registry cold start (not yet refreshed) → use static fallback.
- Fetch failure / endpoint missing → degrade to fallback; never fail the request.
- Resolved id still 404s at the upstream (rare) → forward that 404 as-is (we
  don't retry-resolve).
- Empty/garbage model list from the endpoint → treat as no list (fallback).

## Configuration

- `ENABLE_MODEL_ALIAS` (default on) — master switch.
- `MODEL_REGISTRY_REFRESH_SEC` (default 3600).
- `MODEL_REGISTRY_FALLBACK_*` — override the built-in family→newest map.

## Testing

- **Unit** (`resolveModelAlias`): concrete id pass-through; `-latest`; bare
  family; newest-by-created; tie-break; no-family pass-through; OpenAI
  ambiguous→pass-through.
- **Unit** (`modelRegistry`): cache TTL/refresh; fetch failure → fallback;
  fallback metric.
- **Integration** (routes): alias request rewrites `body.model`, sets the
  response header, and `usage_logs` shows requested(alias) vs upstream(resolved).
- **Spike** (plan step 1, manual, not an automated test): live-probe both
  `/v1/models` endpoints with real credentials.

**Zero schema / migration.**
