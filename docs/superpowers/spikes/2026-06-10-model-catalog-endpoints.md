# Spike: /v1/models endpoints for model alias resolution

**Date:** 2026-06-10
**Method:** in-container (`docker-gateway-1`) node script using `resolveCredential` on the real `anthropic OAuth` upstream (Max OAuth) + the `openai` codex upstream (api_key). Only response *shapes* printed — no tokens.

## Anthropic — `GET https://api.anthropic.com/v1/models`

- **Auth:** Claude Max **OAuth** token works → **HTTP 200** (headers: `authorization: Bearer <oauth>`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`). No rate-limit this run.
- **Shape:** `{ data: [ {type, id, display_name, created_at, max_input_tokens, max_tokens, capabilities} ], has_more, first_id, last_id }`
- **`created_at` = ISO 8601 string** (e.g. `"2026-06-07T00:00:00Z"`). There is NO `created` unix field.
- **Pagination:** `has_more: false` on this account (11 models). Handle `has_more`/`last_id` cursor defensively but not required here.
- Models seen include `claude-fable-5` (created 2026-06-07), `claude-sonnet-4-20250514`, etc.

## OpenAI via sub2api — `GET https://sub2api.onead.tw:2880/v1/models`

- **Endpoint EXISTS** → **HTTP 200** (auth: `authorization: Bearer <api_key>`).
- **Shape:** `{ object: "list", data: [ {id, type, display_name, created_at} ] }`
- **`created_at` = ISO 8601 string** — **NOT** the standard OpenAI `created` (unix seconds) integer. sub2api mirrors the Anthropic-style shape.
- **Pagination:** none (`has_more`/`first_id`/`last_id` absent; 17 models).
- Models include `codex-*`, `gpt-*`, `gpt-image-2`, etc.

## Normalize rules (raw → `ModelCatalogEntry { id, created: epoch_ms }`)

- **Both platforms:** parse `created_at` (ISO string) → `Date.parse(created_at)` (epoch ms). If absent/unparseable → `created: 0`.
- `id` = `data[].id` (string; skip entries without a string id).
- `data` must be an array; otherwise treat as empty (→ fallback).
- Pagination not required for either account today; if `has_more === true` appears later, follow `last_id` as `after_id` cursor (defensive, optional).

## Effective source per platform

- **Anthropic: LIVE** (OAuth and presumably api_key both work — only OAuth verified here).
- **OpenAI (sub2api): LIVE** (endpoint present).
- Static fallback remains the cold-start / failure guard for both.

## ⚠️ Plan adjustment required

`Task 8` (`fetchModelCatalog`) assumed OpenAI returns `created` (unix sec). **Correct it:** for BOTH `anthropic` and `openai`, read `created_at` (ISO) → `Date.parse(...)`. Drop the unix-seconds branch (or keep it only as a fallback if `created_at` is absent). Update the OpenAI test in Task 8 accordingly (`created_at: "..."` not `created: <int>`).
