# Model Alias Resolution — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorming) + spec-review findings folded in — ready for plan
**Scope:** Caliber gateway — adaptive model resolution for Anthropic + OpenAI surfaces

## Problem

The gateway is a pure pass-through for the request `model` field. Clients that
send a stale or family/alias model id get a bare upstream `404` (e.g. a Claude
Max OAuth token rejects `claude-3-5-haiku-20241022` while accepting the current
`claude-haiku-4-5-20251001`). There is no model discovery, validation, or
resolution. We want the gateway to **adaptively resolve model aliases to the
current newest concrete id** so callers don't have to track exact dated ids.

Found during the 2026-06-10 Anthropic OAuth own→own verification: old model ids
404 on Claude Max; current ids work. Crucially, the available model set is a
function of the **credential/entitlement** (Claude Max OAuth vs an api-key
account), so resolution must be entitlement-aware — see the catalog bucketing
invariant below.

## Goal & Non-Goals

**Goal:** When a client sends a model *alias* (a `-latest` suffix or a bare
family name), the gateway resolves it to the newest concrete model id in that
family — sourced from a live, cached `/v1/models` list — and forwards the
rewritten request, using a catalog compatible with the account that actually
serves the request. Explicit concrete ids are never touched.

**Non-Goals:**
- NOT auto-upgrading explicit concrete ids (no silent rewrite of what the client
  explicitly asked for — that would surprise clients on capability/price).
- NOT a model catalog/billing UI.
- NO schema change / migration (reuses `usage_logs.requested_model` /
  `upstream_model`).

## Decisions (brainstorming + review)

| # | Decision |
|---|----------|
| Behavior | **Alias resolution only.** Concrete id (== a known catalog entry for the serving account's bucket) → pass through unchanged. Alias → resolve to family-newest. |
| Alias forms | **Both**: `-latest` suffix (`claude-sonnet-latest`) **and** bare family name (`claude-sonnet`). |
| Platforms | **Both** Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`, `/v1/responses`). |
| Catalog bucketing | **Per `(platform, baseUrl, credential.type)` bucket** — NOT platform-wide. Resolution uses the bucket of the **actually-selected** account. (Finding #1.) |
| List source | Live fetch per bucket + in-memory cache (TTL ~1h) + static fallback. Background-refreshed off the request path. |
| "Newest" | **Max `created` timestamp** from the catalog entry — NOT version-string parsing. |
| Unresolvable | **Pass through** (no new failure mode) — let the upstream respond. |
| Transparency | Log `requested_model`=alias + `upstream_model`=resolved (existing columns); response header `x-caliber-resolved-model` when resolution happened (incl. on cache hits). |

## Catalog bucketing (Finding #1 — the central invariant)

The request's serving account is chosen by the **failover loop** from the
candidate set built by `buildFailoverInput` (routingPolicy / userId / platform).
Different accounts can have different credential classes (Max OAuth vs api-key)
and therefore **different available model sets**. Resolving against the wrong
class can route an api-key-only model to a Max OAuth account (or vice versa) —
exactly the entitlement mismatch behind the original 404.

**Invariants:**
1. The model catalog is keyed by **`(platform, baseUrl, credential.type)`**
   (a "bucket"), not platform-wide.
2. Resolution for a given upstream attempt MUST use the catalog of **that
   attempt's selected account's bucket**.
3. Because account selection happens inside failover, resolution is performed
   **per upstream attempt**, from the original requested alias each time. On
   failover to a different-bucket account, re-resolve against the new bucket.
4. The non-streaming response-cache key MUST include the **resolved** model (see
   Response-cache ordering) so different resolutions never collide.

The plan decides the exact placement (a resolve step inside the failover loop,
after `selectAccount` yields the account+credential, before `callUpstream*`),
but it MUST satisfy invariants 1–4.

**5. Preview bucket vs runtime bucket — distinct sources of truth.**
`buildFailoverInput` only assembles the request scope (`RunFailoverInput`); the
candidate set / account is chosen later in `runFailover → scheduler.select()`,
and the scheduler's sticky layer may go straight to a single account. So the
plan adds a **conservative "bucket preview" helper** that reuses the scheduler's
filtering semantics (incl. sticky) to return only the *possible* bucket set —
from the **row-level `upstream_accounts.type`** hint (NOT a decrypted
credential). The runtime bucket for an actual attempt is formed from
**`credential.type`** after `withSlotAndCredential` decrypts the credential. If
the row `type` and the decrypted credential payload disagree, the attempt
conservatively re-resolves against the credential-derived bucket (or skips) and
emits a warning/metric — never trusts the stale row hint for the live call.

## Core Resolution Flow (per upstream attempt)

```
attempt selects account A (failover loop) → bucket = (platform, A.baseUrl, A.credential.type)
   catalog = registry.get(bucket)            // cached live list, or static fallback
   m = original client requested model
     ├─ m exactly matches a catalog id        → concrete: forward m unchanged
     ├─ m is alias (`<family>-latest` | bare `<family>`)
     │     → pick the family member with max `created` in `catalog`
     │     → rewrite the upstream body's model = resolved id; forward
     │     → for the cacheable/logged result: requested_model=m, upstream_model=resolved
     │     → response header x-caliber-resolved-model: <resolved id>
     └─ alias with no family match (or empty catalog) → forward m unchanged (upstream answers)
```

`requestedModel` (usage logging) is always the **original alias**; the rewritten
upstream body carries the resolved id.

## Components (high cohesion, small files)

- `packages/gateway-core/src/models/resolveModelAlias.ts` — **pure function,
  no I/O**: `(requested, platform, catalog: ModelCatalogEntry[]) → { resolved, wasAlias, family? }`.
  All family-matching + newest-by-`created` logic. Independently unit-testable.
- `packages/gateway-core/src/models/types.ts` — `ModelCatalogEntry = { id, created }`,
  bucket key type, normalized list types.
- **(Finding #2) The I/O layer lives in `apps/gateway`, NOT gateway-core.**
  `apps/gateway/src/models/modelRegistry.ts` (or a Fastify plugin) owns:
  bucket cache, background refresh loop, credential selection + vault decrypt,
  the `/v1/models` fetch+normalize, and the metrics. gateway-core stays
  dependency-thin (pure resolver + types only).
- gateway routes (`messages.ts`, `chatCompletions.ts`, `responses.ts`,
  `codexResponses.ts`) / the failover loop — call the resolver with the selected
  account's bucket catalog, rewrite the upstream body's model, set the response
  header, keep `requestedModel` = the alias.

## Model Registry (apps/gateway — source, cache, fallback)

- **Per-bucket in-memory cache**, keyed `(platform, baseUrl, credential.type)`.
  In-memory per gateway instance (lists are eventually-consistent; no Redis).
- **Background refresh** (off the request path → no per-request latency): every
  `GATEWAY_MODEL_REGISTRY_REFRESH_SEC` (default 3600), refresh each *distinct
  in-use bucket* by fetching that platform/baseUrl's models endpoint with a
  vault-decrypted credential **of that bucket's type** (so the catalog matches
  the entitlement it represents). Buckets are discovered from active upstreams.
- **Static fallback:** a built-in `{ family → newest-known concrete id }` map
  per platform (env-overridable), used on cold start / fetch failure / missing
  endpoint, so resolution keeps working and service is never interrupted.
  Fallback use emits a metric. (Static fallback is bucket-agnostic best-effort;
  documented as such.)

### Feasibility spike (FIRST plan step — before building)

Probe each `/v1/models` endpoint live and capture the **raw response shape**, not
just auth/existence (Finding #5):
1. **Anthropic `GET /v1/models`** — accepts a Claude Max **OAuth** token, or only
   `api_key`? (Determines per-bucket fetch credential.) Capture: id field,
   **timestamp/created field name + format**, pagination, required headers.
2. **OpenAI via sub2api** (`UPSTREAM_OPENAI_BASE_URL`) — does `GET /v1/models`
   exist? Same shape capture. If NOT, OpenAI degrades to **static-fallback-only**
   (still functional). Anthropic is the higher-confidence live path.
3. Define the **normalize rules** raw→`ModelCatalogEntry`: which field maps to
   `created`, how to handle missing timestamps, pagination, and empty/malformed
   bodies. Do NOT assume the provider raw shape already matches the internal type.

## Resolution Semantics

**Concrete vs alias:** if `requested` exactly equals some catalog `id` (for the
serving bucket), it's concrete → pass through. Otherwise attempt alias resolution.

**Family prefix:** `-latest` suffix → strip `-latest`, remainder is the family
prefix. Bare family name → the whole string is the family prefix.

**Family membership:**
- **Anthropic** (clean naming): family `claude-sonnet` → catalog ids starting
  with `claude-sonnet-`; pick max `created`. Same for `claude-haiku`/`claude-opus`.
- **OpenAI** (ambiguous, e.g. `gpt-5` vs `gpt-5-mini`): **conservative.** Require
  the char after the family prefix to begin a version/date segment, not another
  sub-model keyword (mini/nano/turbo/…). If the family can't be matched to a
  single unambiguous member set → **pass through** (don't guess).

**Tie-breaks:** equal `created` → lexicographically-greatest id (deterministic).
No family match / empty catalog → pass through.

## Response-cache ordering (Finding #3)

Resolution MUST occur **before** the non-streaming response-cache key is
computed, and the cache key MUST include the **resolved** model (or the
`{requestedModel, resolvedModel}` pair). Today: `messages.ts` keys off
`upstreamBodyBuf`; `chatCompletions.ts` / `responses.ts` key off the client
body. The plan must ensure those keys reflect the resolved id, so a registry
refresh (e.g. a new family-newest) can't serve a stale cached body for
`claude-sonnet-latest`. On a cache **hit**, still set the
`x-caliber-resolved-model` header.

> Interaction with per-attempt resolution. `checkRouteCache` replies directly on
> a hit, so the resolved model + `x-caliber-resolved-model` must be known *before*
> the cache lookup. Mechanism:
> - Use the **conservative bucket-preview helper** (above) to compute the
>   possible bucket set up front.
> - **`bucketSet.size === 1`** → resolve once up-front against that bucket;
>   use the resolved id for the cache key + header + every attempt.
> - **mixed bucket** (size > 1) → **skip the cache lookup entirely** (we can't
>   know the served attempt's resolved id beforehand); resolve per-attempt
>   inside failover. An optional write-through MAY cache the served attempt's
>   result keyed by its resolved id, but this does NOT guarantee a future
>   mixed-bucket request hits unless its preview converges to a single bucket or
>   reconstructs the same resolved key — documented as best-effort, not relied on.

## OpenAI passthrough usage logging (Finding #4)

`responses.ts` passthrough builds synthetic usage from `requestedModel` as the
upstream model (`runtime/syntheticUsageShapes`), while `usageLogging` writes the
extracted `usage.model`. The plan MUST thread both `originalRequestedModel` and
`resolved/upstreamModel` through the helper signatures so synthetic usage's
`model` is the **resolved id** and `requested_model` stays the alias. Audit all
surfaces (messages, chat/completions ×2, responses translator + passthrough) for
the same requested-vs-upstream split.

## Observability

- Metrics: `gw_model_alias_resolved_total{platform,family}`,
  `gw_model_registry_fetch_total{platform,bucket_type,result}`,
  `gw_model_registry_fallback_used_total{platform,bucket_type}`.
- `usage_logs` already records `requested_model` (alias) vs `upstream_model`
  (resolved) — no schema change.
- Response header `x-caliber-resolved-model: <id>` whenever resolution occurred
  (including cache hits).

## Edge Cases

- Registry cold start (bucket not yet refreshed) → static fallback.
- Fetch failure / endpoint missing → degrade to fallback; never fail the request.
- Resolved id still 404s at the upstream (rare; entitlement edge) → forward that
  404 as-is (we don't retry-resolve within the same attempt).
- Cross-bucket failover → re-resolve from the original alias against the new
  bucket.
- Empty/garbage model list from the endpoint → treat as no list (fallback).

## Configuration (Finding #6 — GATEWAY_ prefix)

- `GATEWAY_ENABLE_MODEL_ALIAS` (default on) — master switch.
- `GATEWAY_MODEL_REGISTRY_REFRESH_SEC` (default 3600).
- `GATEWAY_MODEL_REGISTRY_FALLBACK_*` — override the built-in family→newest map
  per platform.

## Testing

- **Unit** (`resolveModelAlias`, pure): concrete id pass-through; `-latest`; bare
  family; newest-by-`created`; tie-break; no-family pass-through; OpenAI
  ambiguous→pass-through.
- **Unit** (registry, apps/gateway): per-bucket cache TTL/refresh; bucket
  discovery from upstreams; fetch failure → fallback; fallback metric;
  raw→normalized mapping.
- **Integration** (routes/failover): alias rewrites the upstream body for the
  selected bucket; cross-bucket failover re-resolves; response header set;
  `usage_logs` shows requested(alias) vs upstream(resolved); non-streaming cache
  key includes resolved model + header preserved on cache hit; OpenAI passthrough
  synthetic usage uses the resolved id.
- **Spike** (plan step 1, manual): live-probe both `/v1/models` endpoints +
  capture raw shape per the spike checklist above.

**Zero schema / migration.**
