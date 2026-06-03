/**
 * Shared helpers for wiring `enqueueUsageLog` into the non-streaming route
 * handlers (Plan 4A Part 7, Sub-task B).
 *
 * Responsibilities:
 *   - Cache the pricing map at module scope so `loadPricing()` runs once per
 *     process (disk read) rather than per request.
 *   - Extract token counts from a parsed Anthropic response shape in one place
 *     so messages.ts + chatCompletions.ts stay in lockstep.
 *   - Build the fully-validated `UsageLogJobPayload` object from everything
 *     the route already has in scope (req, body, account, parsed upstream
 *     response, timing).
 *   - Encapsulate the "enqueue-or-warn" pattern — when `app.usageLogQueue` is
 *     decorated (production), enqueue via BullMQ with the inline DB fallback
 *     wired; when absent (test mode — see server.ts BuildOpts.redis), log at
 *     debug and skip. Any residual error from `enqueueUsageLog` (meaning BOTH
 *     BullMQ AND inline-DB fallback failed) is logged but NOT re-thrown so
 *     the user-facing response is never blocked by usage-log persistence.
 *
 * This module is imported by both `routes/messages.ts` (non-streaming branch)
 * and `routes/chatCompletions.ts`. Streaming on `/v1/messages` wires its own
 * variant (Sub-task C) that captures firstTokenMs / bufferReleasedAtMs.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  loadPricing,
  resolveCost,
  type PricingMap,
  type CostBreakdown,
  computeCost,
  type PricingLookup,
} from "@caliber/gateway-core";
import {
  enqueueUsageLog,
  type UsageLogJobPayload,
} from "../workers/usageLogQueue.js";
import { writeIdempotencyRecord } from "./idempotencyRecord.js";

// ── Pricing cache ────────────────────────────────────────────────────────────

/**
 * Pricing map is loaded lazily on first access and cached for the process
 * lifetime.  `loadPricing()` reads `packages/gateway-core/pricing/litellm.json`
 * synchronously from disk — acceptable at boot, wasteful per-request.
 *
 * Exported as a getter (not a top-level const) so (a) tests that stub the
 * filesystem can reset via `resetPricingCacheForTests()`, and (b) the cost of
 * the first disk read is deferred past module import.
 */
let cachedPricing: PricingMap | null = null;

export function getPricing(): PricingMap {
  if (cachedPricing === null) {
    cachedPricing = loadPricing();
  }
  return cachedPricing;
}

/**
 * Test-only hook: clears the cached pricing map so the next `getPricing()`
 * call re-reads from disk. Not exported from the package surface; internal
 * tests import it directly.
 */
export function resetPricingCacheForTests(): void {
  cachedPricing = null;
}

// ── Token extraction ─────────────────────────────────────────────────────────

/**
 * Shape we read off a parsed Anthropic Messages response. The real type is
 * `AnthropicMessagesResponse` from `@caliber/gateway-core`, but we accept
 * `unknown` and narrow defensively because the body arrived across the wire
 * and must never trust its shape.
 */
export interface ExtractedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Aggregate cache-creation tokens (5m + 1h on Anthropic; always 0 on OpenAI). */
  cacheCreationTokens: number;
  cacheReadTokens: number;
  // Plan 5A — fields below default to 0 in the current Anthropic extractor.
  // Part 9 wires the OpenAI path that populates `cachedInputTokens`, and a
  // future Anthropic upgrade will populate the 5m/1h split when the API
  // exposes it via `cache_creation.ephemeral_5m_input_tokens` etc.
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cachedInputTokens: number;
}

/**
 * Safely extract usage + model from a parsed upstream Anthropic response.
 *
 * Returns a fully-populated `ExtractedUsage` with zero-filled token fields
 * when the upstream omits them, and an empty-string model when the upstream
 * omits `model`. Callers treat empty `model` as a pricing miss (which is the
 * same bucket as "unknown model" semantically).
 *
 * Never throws — a malformed upstream response becomes an all-zero usage
 * record plus empty model, which still produces a valid row for forensics.
 */
export function extractUsageFromAnthropicResponse(
  parsed: unknown,
): ExtractedUsage {
  if (!parsed || typeof parsed !== "object") {
    return {
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cachedInputTokens: 0,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const usage =
    obj.usage && typeof obj.usage === "object"
      ? (obj.usage as Record<string, unknown>)
      : {};
  // Anthropic prompt-cache split (when present): usage.cache_creation is an
  // object with `ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`.
  // Older API versions only return the aggregate `cache_creation_input_tokens`.
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === "object"
      ? (usage.cache_creation as Record<string, unknown>)
      : {};
  // OpenAI cached_input lives at `usage.prompt_tokens_details.cached_tokens`.
  // We read it here defensively so a future OpenAI-shaped response routed
  // through this extractor still records `cachedInputTokens` correctly;
  // Part 9 may add a dedicated `extractUsageFromOpenaiResponse` that uses
  // `prompt_tokens` / `completion_tokens` for the totals, but the cached
  // sub-portion still surfaces the same way.
  const promptDetails =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  return {
    model: typeof obj.model === "string" ? obj.model : "",
    inputTokens: toNonNegInt(usage.input_tokens),
    outputTokens: toNonNegInt(usage.output_tokens),
    cacheCreationTokens: toNonNegInt(usage.cache_creation_input_tokens),
    cacheReadTokens: toNonNegInt(usage.cache_read_input_tokens),
    cacheCreation5mTokens: toNonNegInt(cacheCreation.ephemeral_5m_input_tokens),
    cacheCreation1hTokens: toNonNegInt(cacheCreation.ephemeral_1h_input_tokens),
    cachedInputTokens: toNonNegInt(promptDetails.cached_tokens),
  };
}

function toNonNegInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// ── Payload builder ──────────────────────────────────────────────────────────

/**
 * Client URL space the request hit. NOT the upstream platform — both
 * fields exist in the row because the inbound surface and the upstream
 * provider can disagree (e.g. /v1/chat/completions hitting an Anthropic
 * upstream after translation; /v1/responses hitting Anthropic in 5A
 * before the openai handlers ship).
 */
export type UsageLogSurface = "messages" | "chat-completions" | "responses";

/**
 * Inbound URL space platform — derived from the route, NOT from the
 * resolved upstream. /v1/messages uses "anthropic"; /v1/chat/completions
 * + /v1/responses use "openai". Operators reading this column want to
 * know "which client format did the user speak?" — pair it with
 * `accountId` (and that account's row's `platform`) to get the upstream
 * provider answer.
 */
export type UsageLogInboundPlatform = "anthropic" | "openai";

/**
 * Map a `UsageLogSurface` (the client URL space) to its inbound
 * platform value. This codifies the convention so route handlers
 * stop guessing at the call site:
 *   * /v1/messages          → anthropic (Anthropic Messages format)
 *   * /v1/chat/completions  → openai    (OpenAI Chat format)
 *   * /v1/responses         → openai    (OpenAI Responses format)
 *
 * Cross-format routes (e.g. Anthropic-format /v1/messages dispatched
 * to an OpenAI upstream) still use the *inbound* surface here — the
 * upstream provider can be inferred from `account.platform` for
 * dashboards that want the upstream pivot.
 */
export function usageLogInboundPlatformForSurface(
  surface: UsageLogSurface,
): UsageLogInboundPlatform {
  return surface === "messages" ? "anthropic" : "openai";
}

export interface BuildUsageLogPayloadInput {
  req: FastifyRequest;
  /** Client-requested model (e.g., `body.model` from the inbound request). */
  requestedModel: string;
  accountId: string;
  /** Parsed upstream Anthropic response body (used for usage + upstreamModel). */
  upstreamResponse: unknown;
  /** Inbound URL-space platform — see `UsageLogInboundPlatform` for nuance. */
  platform: UsageLogInboundPlatform;
  /** Client URL space — see `UsageLogSurface`. */
  surface: UsageLogSurface;
  /** HTTP status code sent downstream to the client. */
  statusCode: number;
  /** Wall-clock ms since the request started (route handler entry). */
  durationMs: number;
  /** Pre-loaded pricing map (pass `getPricing()`). */
  pricing: PricingMap;
  /**
   * Plan 5A — DB-backed pricing lookup. When provided AND the upstream model
   * is in `model_pricing`, the new pricing path runs (`computeCost` over a
   * bigint micros row) and `inputCost`/`outputCost`/`cacheCreationCost`/
   * `cacheReadCost`/`cachedInputCost` reflect that source.  When omitted (or
   * present but missing the model), the legacy `resolveCost(pricing, ...)`
   * path runs as before — full backwards compat for 4A-era models still
   * served by `litellm.json` but not yet seeded into `model_pricing`.
   */
  pricingLookup?: PricingLookup;
  /**
   * Plan 5A — group routing trail.  Threaded through from the upstream
   * dispatcher when an api-key has been bound to a group (PR #31).  NULL
   * for legacy/unbound api-keys.
   */
  groupId?: string | null;
  /**
   * Plan 5A — group rate multiplier in effect for this request.  Defaults
   * to "1.0000" (no markup).  Persisted verbatim into the `rate_multiplier`
   * audit column AND used to compute `actualCost`.
   */
  rateMultiplier?: string;
  /**
   * Plan 5A — per-account rate multiplier in effect for this request.
   * Defaults to "1.0000".  Persisted verbatim into `account_rate_multiplier`
   * AND folded into `actualCost`.
   */
  accountRateMultiplier?: string;
  /**
   * Plan 5A — upstream account.type. When `"oauth"`, the row records cost=0
   * (subscription is sunk cost per X11) and `actualCost=0`.  When `"apikey"`
   * (or omitted; the default), per-token cost is computed via
   * `pricingLookup` / `resolveCost`.
   */
  accountType?: "oauth" | "apikey";
  /**
   * True when the client opted into SSE streaming (`stream=true`).  Drives
   * the `usage_logs.stream` column.  Defaults to `false` for backward
   * compatibility with non-streaming callers.
   */
  stream?: boolean;
  /**
   * Streaming only — ms between request start and the first upstream byte
   * the gateway observed. `null` when the upstream emitted zero bytes.
   * Ignored when `stream === false`; non-streaming callers may omit.
   */
  firstTokenMs?: number | null;
  /**
   * Streaming only — ms between request start and the moment `SmartBuffer`
   * committed (transitioned BUFFERING → COMMITTED) and began flushing bytes
   * to the client. `null` when the buffer never committed (e.g., zero-byte
   * upstream stream). Ignored when `stream === false`.
   */
  bufferReleasedAtMs?: number | null;
}

export interface BuildUsageLogPayloadResult {
  payload: UsageLogJobPayload;
  cost: CostBreakdown;
}

/**
 * Assemble the full `UsageLogJobPayload` for a successful non-streaming
 * request. Computes cost via the injected pricing map; when the map misses
 * the upstream model, cost decimals are zero and `cost.miss === true` (the
 * caller should bump `gw_pricing_miss_total` + log a warning).
 *
 * Placeholders per Sub-task B handoff doc:
 *   - `rateMultiplier` and `accountRateMultiplier` default to `"1.0000"`
 *     until per-key/per-account markup policy lands.
 *   - `upstreamRetries` is `0` and `failedAccountIds` is `[]` until the
 *     failover loop exposes those counters.
 *
 * Streaming-only fields are set to null:
 *   - `firstTokenMs` (time to first SSE chunk)
 *   - `bufferReleasedAtMs` (time the smart-buffer commit fired)
 */
export async function buildUsageLogPayload(
  input: BuildUsageLogPayloadInput,
): Promise<BuildUsageLogPayloadResult> {
  const usage = extractUsageFromAnthropicResponse(input.upstreamResponse);
  const accountType = input.accountType ?? "apikey";
  const rateMultiplier = input.rateMultiplier ?? "1.0000";
  const accountRateMultiplier = input.accountRateMultiplier ?? "1.0000";

  // Plan 5A two-stage billing:
  //   - OAuth subscription rows: cost=0 unconditionally (X11 — subscription
  //     is sunk cost; ledger row written for visibility, not budget).
  //   - apikey rows: try DB-backed pricingLookup first (when provided), fall
  //     back to legacy resolveCost otherwise.  Legacy is the canonical 4A
  //     path; DB lookup is the future home once `model_pricing` covers the
  //     full model catalogue.
  let cost: CostBreakdown;
  let cachedInputCost = 0;
  if (accountType === "oauth") {
    cost = {
      inputCost: 0,
      outputCost: 0,
      cacheCreationCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
      miss: false,
    };
  } else {
    const resolved = await resolveCostAndCachedInput(input, usage);
    cost = resolved.cost;
    cachedInputCost = resolved.cachedInputCost;
  }

  const totalWithCachedInput = cost.totalCost + cachedInputCost;
  // TODO(plan-5a): float-arithmetic precision is fine for numeric(20, 10)
  // truncated to 10 decimals, but leaves a tiny ULP-drift risk on the
  // last digit. If/when high-volume aggregation depends on this column
  // being exact, switch to bigint-micros math (multiply numerator
  // multipliers as integer percentages, e.g. rateMultiplier 1.5 → 15000n
  // with scale 10000) and convert to dollar string at the boundary.
  const actualCostUsd =
    totalWithCachedInput *
    parseFloat(rateMultiplier) *
    parseFloat(accountRateMultiplier);

  // The apiKey / gwUser decorations are populated by apiKeyAuthPlugin which
  // rejects with 401 before the route handler runs; the bang assertions
  // match the defense-in-depth check at the top of each route.
  const apiKey = input.req.apiKey!;
  const gwUser = input.req.gwUser!;

  const payload: UsageLogJobPayload = {
    requestId: input.req.id,
    userId: gwUser.id,
    apiKeyId: apiKey.id,
    accountId: input.accountId,
    orgId: apiKey.orgId,
    teamId: apiKey.teamId ?? null,
    requestedModel: input.requestedModel,
    upstreamModel: usage.model,
    platform: input.platform,
    surface: input.surface,
    stream: input.stream ?? false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    // Plan 5A — Anthropic 5m/1h split + OpenAI cached_input.  Defaults to 0
    // until the corresponding upstream-response extractors are wired in
    // Part 9 (OpenAI route handlers); the columns are populated then.
    cacheCreation5mTokens: usage.cacheCreation5mTokens,
    cacheCreation1hTokens: usage.cacheCreation1hTokens,
    cachedInputTokens: usage.cachedInputTokens,
    inputCost: cost.inputCost.toFixed(10),
    outputCost: cost.outputCost.toFixed(10),
    cacheCreationCost: cost.cacheCreationCost.toFixed(10),
    cacheReadCost: cost.cacheReadCost.toFixed(10),
    cachedInputCost: cachedInputCost.toFixed(10),
    totalCost: totalWithCachedInput.toFixed(10),
    actualCostUsd: actualCostUsd.toFixed(10),
    rateMultiplier,
    accountRateMultiplier,
    groupId: input.groupId ?? null,
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    // Streaming-only fields. Non-streaming callers omit them (defaults below)
    // and the non-null shape of the `usage_logs` columns tolerates null via
    // the bigserial/integer nullability declared in the schema.
    firstTokenMs: input.stream === true ? (input.firstTokenMs ?? null) : null,
    bufferReleasedAtMs:
      input.stream === true ? (input.bufferReleasedAtMs ?? null) : null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent:
      typeof input.req.headers["user-agent"] === "string"
        ? input.req.headers["user-agent"]
        : null,
    // Empty-string → null: an empty `req.ip` is not a valid address and the
    // downstream persister (Postgres `inet`) would reject it anyway.
    ipAddress:
      typeof input.req.ip === "string" && input.req.ip.length > 0
        ? input.req.ip
        : null,
  };

  return { payload, cost };
}

/**
 * Resolve cost (4-field legacy shape) and OpenAI cached_input cost in a
 * single call.  Behaviour:
 *
 *   - When `pricingLookup` is provided AND the upstream model is in
 *     `model_pricing`: use `computeCost` (bigint micros). One DB lookup,
 *     one computeCost — both branches share the result.
 *   - Otherwise: fall back to legacy `resolveCost(loadPricing(), ...)`.
 *     `cachedInputCost` is 0 in that branch (the legacy 4A pricing path
 *     has no cached_input concept).
 *
 * Provider-specific normalisation: `computeCost`'s contract is "inputTokens
 * = total prompt size; cache-classified tokens are subtracted before
 * billing input."  Anthropic's `usage.input_tokens` is **uncached-only**
 * (cache_creation/read are independent counts that don't overlap), so
 * passing it raw would underbill input.  We re-aggregate cache fields back
 * into inputTokens here so each token bills exactly once.  OpenAI's
 * `prompt_tokens` is already the total — for OpenAI rows the
 * cache_5m/1h/read fields are 0 so the addition is a no-op.
 */
async function resolveCostAndCachedInput(
  input: BuildUsageLogPayloadInput,
  usage: ExtractedUsage,
): Promise<{ cost: CostBreakdown; cachedInputCost: number }> {
  if (input.pricingLookup && usage.model) {
    const row = await input.pricingLookup.lookup(
      input.platform,
      usage.model,
      new Date(),
    );
    if (row) {
      // Anthropic's API may return either the per-tier split
      // (`cache_creation.ephemeral_5m/1h_input_tokens`) OR only the
      // aggregate `cache_creation_input_tokens`.  When only the aggregate
      // is present, the upstream defaulted to the 5min cache TTL (per
      // Anthropic prompt-cache docs) — bill the aggregate as 5m so the
      // ledger matches the legacy `resolveCost` path's
      // `cache_creation_input_token_cost` bucket.
      const haveSplit =
        usage.cacheCreation5mTokens > 0 || usage.cacheCreation1hTokens > 0;
      const cache5mTokens = haveSplit
        ? usage.cacheCreation5mTokens
        : usage.cacheCreationTokens;
      const cache1hTokens = haveSplit ? usage.cacheCreation1hTokens : 0;
      // computeCost contract: `inputTokens` is total prompt size; cache
      // fields are subtracted from it before billing input.  Anthropic's
      // `usage.input_tokens` is uncached-only, so re-aggregate cache
      // counts back in here to match the contract.  OpenAI's
      // `prompt_tokens` is already total — but for OpenAI rows the
      // cache_creation/read fields are 0 (Anthropic concept), so the
      // addition is a no-op there.
      const totalPromptInput =
        usage.inputTokens +
        cache5mTokens +
        cache1hTokens +
        usage.cacheReadTokens;
      const computed = computeCost(row, {
        inputTokens: totalPromptInput,
        outputTokens: usage.outputTokens,
        cacheCreation5mTokens: cache5mTokens,
        cacheCreation1hTokens: cache1hTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cachedInputTokens: usage.cachedInputTokens,
      });
      return {
        cost: {
          inputCost: computed.breakdown.input,
          outputCost: computed.breakdown.output,
          cacheCreationCost: computed.breakdown.cacheCreation,
          cacheReadCost: computed.breakdown.cacheRead,
          // computed.totalCost includes cachedInput; subtract here so the
          // CostBreakdown.totalCost mirrors the legacy 4-field shape
          // (which had no cachedInput concept). Cached-input cost is
          // re-added at the payload level alongside `cachedInputCost`.
          totalCost: computed.totalCost - computed.breakdown.cachedInput,
          miss: false,
        },
        cachedInputCost: computed.breakdown.cachedInput,
      };
    }
  }
  return {
    cost: resolveCost(input.pricing, usage.model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
    }),
    cachedInputCost: 0,
  };
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EmitUsageLogInput {
  app: FastifyInstance;
  req: FastifyRequest;
  requestedModel: string;
  accountId: string;
  upstreamResponse: unknown;
  platform: UsageLogInboundPlatform;
  surface: UsageLogSurface;
  statusCode: number;
  durationMs: number;
  /**
   * Streaming metadata — all optional for backward compatibility with the
   * non-streaming callers added in Sub-task B.  Streaming callers
   * (Sub-task C) pass `stream: true` and the two ms fields measured against
   * the same `startedAtMs` used to compute `durationMs`.
   */
  stream?: boolean;
  firstTokenMs?: number | null;
  bufferReleasedAtMs?: number | null;
  // Plan 5A — pass-through to buildUsageLogPayload.  All optional; when
  // omitted, the legacy 4A behaviour is preserved (no DB pricing lookup,
  // multipliers default to 1.0, groupId null, account treated as apikey).
  pricingLookup?: PricingLookup;
  groupId?: string | null;
  rateMultiplier?: string;
  accountRateMultiplier?: string;
  accountType?: "oauth" | "apikey";
}

/**
 * Build the payload and enqueue it, handling:
 *   - Test mode (`app.usageLogQueue` undefined → log at debug, skip).
 *   - Pricing misses (warn + bump `gw_pricing_miss_total`; still enqueue
 *     with zero-cost so operators see the row).
 *   - BullMQ enqueue + inline-fallback both failed (warn at the route; the
 *     structured `gw_usage_persist_lost` log + metric already fired inside
 *     `enqueueUsageLog`). NEVER re-throws — usage-log persistence must not
 *     fail a successful user request.
 *
 * Synchronous on the happy path (BullMQ `queue.add` is a Redis publish,
 * sub-ms); on Redis failure, the inline DB fallback runs synchronously so
 * the row is committed before the route returns.
 */
export async function emitUsageLog(input: EmitUsageLogInput): Promise<void> {
  const { app, req } = input;
  // Top-level try/catch enforces the documented never-throws contract:
  // a successful upstream response must never surface as a 500 to the
  // client because of a usage-log-emission failure. This wraps EVERY
  // code path — `getPricing()` (disk-read on first call), the synchronous
  // `buildUsageLogPayload`, the pricing-miss metering, AND the enqueue
  // — so any thrown error lands here and is logged, not propagated.
  try {
    // gw_upstream_duration_seconds (issue #190): observe end-to-end request
    // latency. durationMs is dominated by the upstream LLM call (translation /
    // credential / slot acquire are sub-/low-ms), so this is a faithful proxy
    // for upstream latency. Emitted here because every surface funnels through
    // emitUsageLog with a durationMs measured against the same startedAtMs.
    app.gwMetrics.upstreamDurationSeconds.observe(input.durationMs / 1000);

    const { payload, cost } = await buildUsageLogPayload({
      req,
      requestedModel: input.requestedModel,
      accountId: input.accountId,
      upstreamResponse: input.upstreamResponse,
      platform: input.platform,
      surface: input.surface,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      pricing: getPricing(),
      stream: input.stream,
      firstTokenMs: input.firstTokenMs,
      bufferReleasedAtMs: input.bufferReleasedAtMs,
      pricingLookup: input.pricingLookup,
      groupId: input.groupId,
      rateMultiplier: input.rateMultiplier,
      accountRateMultiplier: input.accountRateMultiplier,
      accountType: input.accountType,
    });

    if (cost.miss) {
      // Bump the counter using the upstream-reported model (empty string when
      // the upstream omitted it — still a valid label value for the counter).
      app.gwMetrics.pricingMissTotal.inc({ model: payload.upstreamModel });
      req.log.warn(
        {
          requestId: payload.requestId,
          upstreamModel: payload.upstreamModel,
          requestedModel: payload.requestedModel,
        },
        "pricing miss — usage log row will record zero cost",
      );
    }

    const xReqId = req.headers["x-request-id"];
    const requestKey = Array.isArray(xReqId) ? xReqId[0] : xReqId;
    if (requestKey && app.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0 && app.db) {
      writeIdempotencyRecord({
        db: app.db,
        requestKey,
        ttlSec: app.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC,
        payload: {
          apiKeyId: payload.apiKeyId,
          orgId: payload.orgId,
          userId: payload.userId,
          requestId: payload.requestId,
          requestedModel: payload.requestedModel,
          surface: payload.surface,
          platform: payload.platform,
          statusCode: payload.statusCode,
          totalCost: payload.totalCost,
          actualCostUsd: payload.actualCostUsd,
        },
      });
    }

    if (!app.usageLogQueue) {
      // Test mode (server.ts skips BullMQ when opts.redis is injected).
      req.log.debug(
        { requestId: payload.requestId },
        "usage log queue absent; skipping enqueue (test mode)",
      );
      return;
    }

    try {
      await enqueueUsageLog(app.usageLogQueue, payload, {
        fallback: {
          db: app.db,
          logger: req.log,
          // Direct Counter ref — satisfies UsageLogFallbackMetrics via `.inc()`.
          metrics: app.gwMetrics.usagePersistLostTotal,
        },
      });
    } catch (enqueueErr) {
      // BullMQ failed AND inline fallback also failed. The structured
      // `gw_usage_persist_lost` log + metric already happened inside
      // `enqueueUsageLog`. Don't fail the user request — just acknowledge.
      req.log.warn(
        {
          err:
            enqueueErr instanceof Error
              ? enqueueErr.message
              : String(enqueueErr),
          requestId: payload.requestId,
        },
        "usage log persist failed (already metered as gw_usage_persist_lost)",
      );
    }
  } catch (err) {
    // Something upstream of the enqueue failed — pricing load, payload
    // construction, or metric increment. Record it and return without
    // throwing so the user's successful response is unaffected.
    req.log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        requestId: req.id,
      },
      "usage log emit failed; user request unaffected",
    );
  }
}
