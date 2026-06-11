import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@caliber/config";
import {
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  translateChatToResponses,
  translateResponsesResponseToChat,
  makeAnthropicToChatStream,
  makeResponsesToChatStream,
  parseAnthropicSse,
  parseOpenAIResponsesSse,
  type OpenAIChatRequest,
  type OpenAIStreamChunk,
  type ResponsesUsage,
} from "@caliber/gateway-core";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
  NoOwnUpstreamError,
} from "../runtime/failoverLoop.js";
import { buildFailoverInput } from "../runtime/buildFailoverInput.js";
import {
  noOwnUpstreamReplyBody,
  NO_OWN_UPSTREAM_STATUS,
} from "../runtime/noOwnUpstream.js";
import {
  checkRouteCache,
  tryStoreOnSuccess,
} from "../runtime/responseCache.js";
import { storeIdempotent } from "../runtime/idempotencyCache.js";
import { checkRequestIdempotency } from "./idempotencyEntry.js";
import { resolveCredential } from "../runtime/resolveCredential.js";
import { maybeRefreshOAuth } from "../runtime/oauthRefresh.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { callUpstreamResponses } from "../runtime/upstreamCallOpenai.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";
import {
  emitUsageLog,
  usageLogInboundPlatformForSurface,
} from "../runtime/usageLogging.js";
import { emitBodyCapture } from "../runtime/bodyCapture.js";
import { withSlotAndCredential } from "../runtime/withSlotAndCredential.js";
import { buildSyntheticAnthropicUsage } from "../runtime/syntheticUsageShapes.js";
import { buildUpstreamHttpError } from "../runtime/upstreamErrorMapping.js";
import {
  serializeChatSseError,
  respondStreamFailoverCollapse,
  fatalUpstreamReplyBody,
} from "../runtime/sseErrorEvents.js";
import { autoRoute } from "./dispatch.js";
import {
  applyModelResolution,
  type Output as ModelResolution,
} from "../models/applyModelResolution.js";
import { listCandidateTypes } from "../models/candidateTypes.js";
import {
  buildAliasScope,
  applyAliasResolved,
  rewriteUpstreamModel,
  applyUpfrontDrift,
} from "../models/aliasWiring.js";

export interface ChatCompletionsRouteOptions {
  env: ServerEnv;
}

/** Safety-net expiry: slot key expires in Redis even if release is missed. */
const SLOT_DURATION_MS = 60_000;

export async function chatCompletionsRoutes(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
): Promise<void> {
  // Plan 5A PR 9i — autoRoute by group platform. Anthropic-platform
  // groups keep the 4A handler (Chat → Anthropic Messages → Anthropic
  // upstream → Messages → Chat). Openai-platform groups dispatch to
  // the new handler that pivots Chat ↔ Responses to call OpenAI's
  // Responses API (used for ChatGPT subscription accounts that don't
  // expose Chat Completions natively).
  app.post(
    "/v1/chat/completions",
    autoRoute({
      anthropic: makeChatCompletionsAnthropicHandler(app, opts),
      openai: makeChatCompletionsOpenaiHandler(app, opts),
    }),
  );
}

/**
 * Original 4A handler for the Anthropic-upstream branch — extracted into
 * a factory so the autoRoute wrap can dispatch by group platform.
 *
 * Body unchanged from the inline handler that PR 9a originally
 * registered; the only structural difference is the closure return.
 */
export function makeChatCompletionsAnthropicHandler(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // apiKeyAuthPlugin should have already rejected unauthenticated requests.
    // Defense-in-depth: verify decorations are present.
    if (!req.apiKey || !req.gwUser || !req.gwOrg) {
      reply.code(401).send({ error: "missing_api_key" });
      return;
    }

    // Body — Fastify auto-parses application/json before this handler runs.
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    // Early-exit: model must be present before any DB/Redis work.
    if (typeof body.model !== "string" || body.model.length === 0) {
      reply.code(400).send({ error: "missing_model" });
      return;
    }

    // Translate OpenAI request → Anthropic shape (pure function; throws on bad input)
    let anthropicBody;
    try {
      anthropicBody = translateOpenAIToAnthropic(body as never);
    } catch (err) {
      reply.code(400).send({
        error: "invalid_request",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const requestId = req.id;
    const isStream = body.stream === true;

    // Model-alias resolution (feat/model-alias-resolution). The client `model`
    // (OpenAI Chat shape) is the alias; resolve it against the ANTHROPIC catalog
    // (this branch translates Chat → Anthropic Messages and forwards to the
    // Anthropic upstream) and rewrite the TRANSLATED body's `model`. Runs after
    // the missing_model check and before `upstreamBodyBuf` so a single-bucket
    // resolution bakes the concrete id into the forwarded body + cache key.
    const aliasScope = buildAliasScope(req);
    const resolution = await applyModelResolution({
      requested: body.model,
      platform: "anthropic",
      baseUrl:
        opts.env.UPSTREAM_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      enabled: opts.env.GATEWAY_ENABLE_MODEL_ALIAS,
      registry: app.modelRegistry,
      listCandidateTypes: () => listCandidateTypes(app.db, aliasScope),
    });

    // For the streaming path we need the upstream to also stream — set
    // `stream: true` on the translated Anthropic body so
    // `callUpstreamMessages` requests text/event-stream. Single-bucket
    // resolution rewrites the translated body's `model` up front; mixed-bucket
    // (`upfront === null`) defers to the per-attempt path in the failover loop.
    const upstreamBody: Record<string, unknown> = isStream
      ? { ...anthropicBody, stream: true }
      : { ...anthropicBody };
    if (resolution.upfront) {
      upstreamBody.model = resolution.upfront.upstreamModel;
      if (resolution.upfront.wasAlias) {
        applyAliasResolved(app, reply, resolution.upfront, "anthropic");
      }
    }
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));

    // Idempotency cache (design §4.5) — client-opt-in via X-Request-Id. Runs
    // for stream + non-stream; only non-stream 200s get stored for replay.
    const idem = await checkRequestIdempotency(app, opts.env, req, reply);
    if (idem.handled) return;
    const idemKey = idem.idemKey;

    // Phase 3 #2 — cache scope `v1/chat/completions` keyed on the
    // CLIENT body (openai-chat shape), shared across this handler and
    // the openai-platform branch so a reconfigured group hits the same
    // cache. Skipped for streaming. Finding 1: key on the RESOLVED model
    // (single-bucket) so an alias request can't keep hitting a stale cached
    // response after the registry remaps it. Mixed-bucket skips the cache via
    // `resolution.cacheable`.
    const cacheKeyBody = resolution.upfront
      ? { ...body, model: resolution.upfront.upstreamModel }
      : body;
    const clientBodyBuf = Buffer.from(JSON.stringify(cacheKeyBody));
    let cacheKey: string | null = null;
    if (!isStream && resolution.cacheable) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/chat/completions",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
        onRedisError: () =>
          app.gwMetrics.redisErrorTotal.inc({ op: "cache_read" }),
      });
      if (result.hit) return;
      cacheKey = result.cacheKey;
    }

    if (isStream) {
      await runChatCompletionsStreamingFailover(
        app,
        opts,
        req,
        reply,
        upstreamBodyBuf,
        requestId,
        resolution.requestedModel,
        resolution,
      );
      return;
    }

    // Capture start time BEFORE the failover loop so durationMs includes
    // request translation + credential resolve + slot acquire + failover
    // switches. See usageLogging.ts for payload semantics.
    const startedAtMs = Date.now();
    // Pull client-requested model from the resolution (the original alias).
    // This is the OpenAI model name (e.g., "claude-haiku") the client sent —
    // distinct from the Anthropic upstream model that comes back in
    // `parsed.model` (which is the RESOLVED id the upstream echoed).
    const requestedModel = resolution.requestedModel;

    try {
      const openaiResponse = await runFailover(buildFailoverInput(req, app.db, {
        maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
        scheduler: app.gwScheduler,
        attempt: async (account) => {
          // Per-account concurrency slot via Redis ZSET.
          const acquired = await acquireSlot(
            app.redis,
            "account",
            account.id,
            requestId,
            account.concurrency,
            SLOT_DURATION_MS,
            app.gwMetrics.slotAcquireTotal,
          );
          if (!acquired) {
            // Treat as a transient failure so failover loop tries another account.
            throw { status: 503, message: "account_at_capacity" };
          }
          // gw_slot_hold_duration_seconds (issue #190) — time slot hold.
          const slotAcquiredMs = Date.now();
          try {
            let credential = await resolveCredential(app.db, account.id, {
              masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
            });
            if (credential.type === "oauth") {
              credential = await maybeRefreshOAuth(
                app.db,
                app.redis,
                account.id,
                credential,
                {
                  masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
                  leadMinutes: opts.env.GATEWAY_OAUTH_REFRESH_LEAD_MIN,
                  maxFail: opts.env.GATEWAY_OAUTH_MAX_FAIL,
                  keychainEndpoint: opts.env.GATEWAY_KEYCHAIN_HELPER_ENDPOINT,
                  keychainTokenPath: opts.env.GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH,
                  logger: app.log,
                  oauthRefreshDeadMetric: app.gwMetrics.oauthRefreshDeadTotal,
                },
              );
            }

            // Alias resolution against the LIVE credential bucket.
            //   * Mixed-bucket (`upfront === null`): rewrite the translated
            //     body's model per the runtime type. Set-or-CLEAR the reply
            //     header per attempt so a failed alias attempt can't leak a
            //     stale `x-caliber-resolved-model` into a later non-alias winner
            //     (Finding 4).
            //   * Single-bucket (`upfront !== null`): the row id is baked into
            //     `upstreamBodyBuf`; re-resolve and, on drift, rewrite to the
            //     credential-derived id + warn/metric (design invariant 5) and
            //     re-point/clear the up-front reply header to match.
            let attemptBodyBuf: Buffer = upstreamBodyBuf;
            if (resolution.upfront === null) {
              const ra = resolution.perAttempt(credential.type);
              attemptBodyBuf = rewriteUpstreamModel(upstreamBodyBuf, ra);
              if (ra.wasAlias) {
                applyAliasResolved(app, reply, ra, "anthropic");
              } else {
                reply.removeHeader("x-caliber-resolved-model");
              }
            } else if (resolution.upfront) {
              const ra = resolution.perAttempt(credential.type);
              attemptBodyBuf = applyUpfrontDrift(
                app,
                upstreamBodyBuf,
                resolution.upfront,
                ra,
                "anthropic",
                { requestId, accountId: account.id },
              );
              if (ra.upstreamModel !== resolution.upfront.upstreamModel) {
                if (ra.wasAlias) {
                  reply.header("x-caliber-resolved-model", ra.upstreamModel);
                } else {
                  reply.removeHeader("x-caliber-resolved-model");
                }
              }
            }

            const result = await callUpstreamMessages({
              baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
              body: attemptBodyBuf,
              credential,
            });

            if (result.kind === "stream") {
              // Defensive guard: stream=true was gated above; upstream should not
              // return SSE for a non-streaming request.
              throw { status: 502, message: "unexpected_stream" };
            }

            // Throw non-2xx so failover classifier sees the status.
            if (result.status < 200 || result.status >= 300) {
              throw buildUpstreamHttpError(result);
            }

            // Parse Anthropic response defensively. A malformed 2xx body
            // would otherwise throw synchronously and cascade into the
            // failover loop as a 503, even though the upstream actually
            // succeeded. Mirror messages.ts behaviour: parse in try/catch,
            // record a zero-usage log row, then throw a 502 so the client
            // sees an honest upstream-malformed error.
            let parsed: unknown = null;
            let parseErr: unknown = null;
            try {
              parsed = JSON.parse(result.body.toString("utf8"));
            } catch (err) {
              parseErr = err;
              req.log.warn(
                {
                  requestId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "upstream 2xx body was not valid JSON; emitting zero-usage log then failing",
              );
            }

            // Enqueue usage-log INSIDE the attempt callback on the success
            // path so `account`, `parsed`, and `startedAtMs` are all in
            // scope without threading closure state out of the failover
            // loop. emitUsageLog never throws — residual errors are logged
            // but do not block the user response. `platform: "openai"` is
            // the inbound surface (client speaks OpenAI); upstream remains
            // Anthropic regardless. On parse failure, parsed === null and
            // `extractUsageFromAnthropicResponse` zero-fills the row so the
            // forensic entry still gets written.
            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse: parsed,
              platform: "openai",
              surface: "chat-completions",
              statusCode: 200,
              durationMs: Date.now() - startedAtMs,
            });
            await emitBodyCapture({
              app,
              req,
              requestId,
              requestBodyJson: attemptBodyBuf.toString("utf8"),
              responseBody: parsed,
              stream: false,
            });

            if (parseErr !== null) {
              // Treat malformed 2xx as a fatal upstream error. The failover
              // loop classifier will surface this as 502 to the client —
              // honest about what actually happened.
              throw { status: 502, message: "upstream_malformed_json" };
            }

            return translateAnthropicToOpenAI(
              parsed as Parameters<typeof translateAnthropicToOpenAI>[0],
            );
          } finally {
            // Release FIRST (swallowed); best-effort metric after, guarded.
            await releaseSlot(
              app.redis,
              "account",
              account.id,
              requestId,
            ).catch(() => {
              // Intentionally swallowed — slot expires on its own within SLOT_DURATION_MS.
            });
            try {
              app.gwMetrics.slotHoldDurationSeconds.observe(
                (Date.now() - slotAcquiredMs) / 1000,
              );
            } catch {
              // metric only
            }
          }
        },
      }));

      const responseBuf = Buffer.from(JSON.stringify(openaiResponse));
      reply
        .code(200)
        .header("content-type", "application/json")
        .send(responseBuf);
      tryStoreOnSuccess(
        {
          redis: app.redis,
          ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
          onRedisError: () =>
            app.gwMetrics.redisErrorTotal.inc({ op: "cache_write" }),
        },
        cacheKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
      storeIdempotent(
        { redis: app.redis, ttlSec: opts.env.GATEWAY_IDEMPOTENCY_TTL_SEC },
        idemKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
    } catch (err) {
      if (err instanceof NoOwnUpstreamError) {
        reply
          .code(NO_OWN_UPSTREAM_STATUS)
          .send(noOwnUpstreamReplyBody(err.platform, requestId));
        return;
      }
      if (err instanceof AllUpstreamsFailed) {
        reply.code(503).send({
          error: "all_upstreams_failed",
          attempted_count: err.attemptedIds.length,
          request_id: requestId,
        });
        return;
      }
      if (err instanceof FatalUpstreamError) {
        reply
          .code(err.statusCode)
          .send(fatalUpstreamReplyBody(err, requestId));
        return;
      }
      throw err; // unexpected — let Fastify default 500 handler take it
    }
  };
}

// ---------------------------------------------------------------------------
// Streaming path (Plan 5A PR 9a — completes 4A Part 6.7 TODO).
//
// Translates `stream: true` OpenAI Chat requests into streaming Anthropic
// upstream calls, parses the Anthropic SSE event stream, runs each event
// through `makeAnthropicToChatStream`, and serializes the OpenAI Chat
// stream chunks back to the client as SSE bytes.
// ---------------------------------------------------------------------------

async function runChatCompletionsStreamingFailover(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  requestedModel: string,
  resolution: ModelResolution,
): Promise<void> {
  reply.hijack();
  const startedAtMs = Date.now();

  // After `reply.hijack()` SSE headers are written via `reply.raw.writeHead`,
  // so the resolved-model header is threaded through this box. Single-bucket:
  // known up front. Mixed-bucket: filled per-attempt before the first byte.
  const resolvedModelHeader: { value: string | null } = {
    value:
      resolution.upfront && resolution.upfront.wasAlias
        ? resolution.upfront.upstreamModel
        : null,
  };
  const streamHeaders = (): Record<string, string> => ({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(resolvedModelHeader.value
      ? { "x-caliber-resolved-model": resolvedModelHeader.value }
      : {}),
  });

  // Wire AbortSignal from client disconnect so a hung upstream is cancelled.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.once("close", onClose);

  try {
    await runFailover(buildFailoverInput(req, app.db, {
      maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
      scheduler: app.gwScheduler,
      attempt: async (account) => {
        const acquired = await acquireSlot(
          app.redis,
          "account",
          account.id,
          requestId,
          account.concurrency,
          SLOT_DURATION_MS,
          app.gwMetrics.slotAcquireTotal,
        );
        if (!acquired) {
          throw { status: 503, message: "account_at_capacity" };
        }
        // gw_slot_hold_duration_seconds (issue #190) — time slot hold.
        const slotAcquiredMs = Date.now();

        try {
          let credential = await resolveCredential(app.db, account.id, {
            masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
          });
          if (credential.type === "oauth") {
            credential = await maybeRefreshOAuth(
              app.db,
              app.redis,
              account.id,
              credential,
              {
                masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
                leadMinutes: opts.env.GATEWAY_OAUTH_REFRESH_LEAD_MIN,
                maxFail: opts.env.GATEWAY_OAUTH_MAX_FAIL,
                keychainEndpoint: opts.env.GATEWAY_KEYCHAIN_HELPER_ENDPOINT,
                keychainTokenPath: opts.env.GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH,
                logger: app.log,
                oauthRefreshDeadMetric: app.gwMetrics.oauthRefreshDeadTotal,
              },
            );
          }

          // Alias resolution against the LIVE credential bucket. Reset the
          // header box per attempt (a failed alias attempt must not leak its
          // resolved id into a non-alias winner).
          //   * Mixed-bucket (`upfront === null`): rewrite per runtime type.
          //   * Single-bucket (`upfront !== null`): re-resolve and, on drift,
          //     rewrite to the credential-derived id + warn/metric (invariant 5)
          //     and re-point the SSE header box at what was actually sent.
          let attemptBodyBuf: Buffer = upstreamBodyBuf;
          if (resolution.upfront === null) {
            const ra = resolution.perAttempt(credential.type);
            attemptBodyBuf = rewriteUpstreamModel(upstreamBodyBuf, ra);
            resolvedModelHeader.value = ra.wasAlias ? ra.upstreamModel : null;
            if (ra.wasAlias) {
              app.gwMetrics.modelAliasResolvedTotal.inc({
                platform: "anthropic",
                family: ra.family ?? "",
              });
            }
          } else if (resolution.upfront) {
            const ra = resolution.perAttempt(credential.type);
            attemptBodyBuf = applyUpfrontDrift(
              app,
              upstreamBodyBuf,
              resolution.upfront,
              ra,
              "anthropic",
              { requestId, accountId: account.id },
            );
            resolvedModelHeader.value = ra.wasAlias ? ra.upstreamModel : null;
          }

          const upstream = await callUpstreamMessages({
            baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
            body: attemptBodyBuf,
            credential,
            signal: ac.signal,
          });

          if (upstream.kind !== "stream") {
            // Upstream may legitimately return a non-streaming error
            // body for 4xx/5xx — surface as a fatal failure with the
            // upstream status so the failover loop classifies correctly.
            throw {
              status: upstream.status,
              message:
                upstream.status >= 400
                  ? upstream.body.toString("utf8").slice(0, 500)
                  : "expected_stream",
            };
          }

          if (upstream.status < 200 || upstream.status >= 300) {
            throw {
              status: upstream.status,
              message: `upstream_${upstream.status}`,
            };
          }

          // Capture the final usage chunk (last chunk that carries
          // `usage`) so we can emit a usage_log row with real token
          // counts. The rest of the chunks are written to the client
          // as soon as they arrive.
          let lastUsageChunk: OpenAIStreamChunk | null = null;
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, streamHeaders());
          }

          const translator = makeAnthropicToChatStream();
          const flushChunk = (chunk: OpenAIStreamChunk | "[DONE]"): void => {
            if (chunk === "[DONE]") {
              reply.raw.write("data: [DONE]\n\n");
              return;
            }
            if (chunk.usage) lastUsageChunk = chunk;
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          };

          try {
            for await (const event of parseAnthropicSse(upstream.body, {
              strict: false,
              onError: (err) => {
                req.log.warn(
                  { requestId, err: err.message },
                  "anthropic SSE parse error — skipping event",
                );
              },
            })) {
              for (const chunk of translator.onEvent(event)) {
                flushChunk(chunk);
              }
            }
            for (const chunk of translator.onEnd()) flushChunk(chunk);
          } catch (err) {
            for (const chunk of translator.onError({
              kind: err instanceof Error ? err.name : "unknown",
              message: err instanceof Error ? err.message : String(err),
            })) {
              flushChunk(chunk);
            }
          }

          reply.raw.end();

          // Emit usage_log + body capture using the captured final chunk.
          // Convert the OpenAI usage shape back to a synthetic Anthropic
          // response so emitUsageLog's pricing path works unchanged.
          const upstreamResponse = lastUsageChunk
            ? syntheticAnthropicResponse(lastUsageChunk)
            : null;
          await emitUsageLog({
            app,
            req,
            requestedModel,
            accountId: account.id,
            upstreamResponse,
            platform: "openai",
            surface: "chat-completions",
            statusCode: 200,
            durationMs: Date.now() - startedAtMs,
          });
          await emitBodyCapture({
            app,
            req,
            requestId,
            requestBodyJson: attemptBodyBuf.toString("utf8"),
            responseBody: null,
            stream: true,
          });
          return undefined as never;
        } finally {
          // Release FIRST (swallowed); best-effort metric after, guarded.
          await releaseSlot(app.redis, "account", account.id, requestId).catch(
            () => {
              // Slot expires on its own.
            },
          );
          try {
            app.gwMetrics.slotHoldDurationSeconds.observe(
              (Date.now() - slotAcquiredMs) / 1000,
            );
          } catch {
            // metric only
          }
        }
      },
    }));
  } catch (err) {
    // Plan 5A PR 9j: unify with the openai-streaming branch so both
    // paths emit the same `{ error: { type, message, request_id } }`
    // shape inside the SSE chunk. Strict improvement — old shape was
    // `{ error: "<reason>", request_id }` which OpenAI SDK clients
    // didn't recognise as a real error event.
    respondStreamFailoverCollapse(reply, err, requestId, serializeChatSseError);
  } finally {
    req.raw.removeListener("close", onClose);
  }
}

/**
 * Adapter from the OpenAI stream chunk's usage shape into the shared
 * synthetic Anthropic shape consumed by `emitUsageLog`'s pricing path.
 * Cache fields default to 0 — the streaming Anthropic API doesn't
 * surface them in the intermediate `message_delta` event we have
 * access to here.
 */
function syntheticAnthropicResponse(
  chunk: OpenAIStreamChunk,
): ReturnType<typeof buildSyntheticAnthropicUsage> {
  return buildSyntheticAnthropicUsage({
    id: chunk.id,
    model: chunk.model,
    inputTokens: chunk.usage?.prompt_tokens ?? 0,
    outputTokens: chunk.usage?.completion_tokens ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Plan 5A PR 9i — openai-platform branch for /v1/chat/completions.
//
// Cross-format flow when an OpenAI Chat client request hits an
// openai-platform group: pivot Chat ↔ Responses so we can hit OpenAI's
// Responses API (used by ChatGPT subscription accounts via the
// Responses surface).
//
//   Non-stream:
//     Chat req → translateChatToResponses → Responses req
//     → callUpstreamResponses → Responses resp
//     → translateResponsesResponseToChat → Chat resp → reply
//
//   Stream:
//     Chat req (with stream=true) → translateChatToResponses → Responses
//     stream req → callUpstreamResponses (SSE) → parseOpenAIResponsesSse
//     → makeResponsesToChatStream → Chat chunks `data: <json>\n\n`
//     terminated with `data: [DONE]\n\n`.
//
// `usage_log.platform` is `"openai"` for both branches (inbound URL
// space — the client speaks Chat, which is the OpenAI surface) per
// `usageLogInboundPlatformForSurface("chat-completions")`. The upstream
// provider is recoverable from the `accountId` join.
// ---------------------------------------------------------------------------

export function makeChatCompletionsOpenaiHandler(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.apiKey || !req.gwUser || !req.gwOrg) {
      reply.code(401).send({ error: "missing_api_key" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      reply.code(400).send({ error: "missing_model" });
      return;
    }

    // Translate Chat → Responses via the composed pivot
    // (chat → anthropic → responses). Pure function; throws on
    // malformed input — caught here and surfaced as 400.
    let responsesBody;
    try {
      responsesBody = translateChatToResponses(
        body as unknown as OpenAIChatRequest,
      );
    } catch (err) {
      reply.code(400).send({
        error: "invalid_request",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const isStream = body.stream === true;
    const requestId = req.id;
    const requestedModel = body.model;
    const startedAtMs = Date.now();

    // Model-alias resolution (feat/model-alias-resolution). Resolves the
    // client `model` against the OpenAI catalog; single-bucket rewrites the
    // upstream Responses body's `model` up front (so the cache key carries the
    // resolved id, spec Finding #3), mixed-bucket defers to the per-attempt
    // path. The cache is keyed on the *client* Chat body (shared with the
    // anthropic-platform branch), so we resolve early to gate cacheability and
    // thread the resolution into the failover helpers.
    const aliasScope = buildAliasScope(req);
    const resolution = await applyModelResolution({
      requested: requestedModel,
      platform: "openai",
      baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
      enabled: opts.env.GATEWAY_ENABLE_MODEL_ALIAS,
      registry: app.modelRegistry,
      listCandidateTypes: () => listCandidateTypes(app.db, aliasScope),
    });

    // Mirror the messages-openai pattern: the upstream needs `stream:
    // true` to return text/event-stream; the client-facing flag is
    // already mirrored on `body.stream`. For single-bucket resolution, bake
    // the resolved model into the upstream body up front; emit header + metric.
    const upstreamBody: Record<string, unknown> = isStream
      ? { ...responsesBody, stream: true }
      : { ...responsesBody };
    if (resolution.upfront) {
      upstreamBody.model = resolution.upfront.upstreamModel;
      if (resolution.upfront.wasAlias) {
        applyAliasResolved(app, reply, resolution.upfront, "openai");
      }
    }
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));

    // Idempotency cache (design §4.5) — client-opt-in via X-Request-Id. Runs
    // for stream + non-stream; only non-stream 200s get stored for replay.
    const idem = await checkRequestIdempotency(app, opts.env, req, reply);
    if (idem.handled) return;
    const idemKey = idem.idemKey;

    // Phase 3 #2 — same scope as the anthropic-platform handler so a
    // group reconfigure doesn't invalidate. Mixed-bucket resolution
    // (`!resolution.cacheable`) skips the cache entirely — the served bucket
    // (and thus the resolved model) isn't known until an account is picked.
    //
    // Finding 5: key the cache on the RESOLVED model (single-bucket), mirroring
    // responses.ts. Keep the Chat client shape — just swap `model` — so a
    // `gpt-5` alias request can't keep hitting a stale cached response after the
    // registry remaps it to a newer concrete id. Mixed-bucket already skips the
    // cache via `resolution.cacheable`, so only the single-bucket key needs the
    // resolved model.
    const cacheKeyBody = resolution.upfront
      ? { ...body, model: resolution.upfront.upstreamModel }
      : body;
    const clientBodyBuf = Buffer.from(JSON.stringify(cacheKeyBody));
    let cacheKey: string | null = null;
    if (!isStream && resolution.cacheable) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/chat/completions",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
        onRedisError: () =>
          app.gwMetrics.redisErrorTotal.inc({ op: "cache_read" }),
      });
      if (result.hit) return;
      cacheKey = result.cacheKey;
    }

    if (isStream) {
      await runChatCompletionsOpenaiStreamingFailover(
        app,
        opts,
        req,
        reply,
        upstreamBodyBuf,
        requestId,
        requestedModel,
        startedAtMs,
        resolution,
      );
      return;
    }

    // AbortSignal from client disconnect → upstream cancel. Without
    // it a hung OpenAI call holds upstream resources up to 60s.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.once("close", onClose);

    try {
      const chatResp = await runFailover(buildFailoverInput(req, app.db, {
        maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
        scheduler: app.gwScheduler,
        attempt: async (account) =>
          withSlotAndCredential(
            app,
            opts,
            account,
            requestId,
            async (credential) => {
              // Alias resolution against the LIVE credential bucket.
              //   * Mixed-bucket (`upfront === null`): rewrite the upstream
              //     body's model per the runtime type. Set-or-CLEAR the reply
              //     header per attempt so a failed alias attempt can't leak a
              //     stale `x-caliber-resolved-model` into a later non-alias
              //     winner (Finding 4).
              //   * Single-bucket (`upfront !== null`): the row id is baked into
              //     `upstreamBodyBuf`; re-resolve and, on drift, rewrite to the
              //     credential-derived id + warn/metric (Finding 2) and
              //     re-point/clear the up-front reply header to match.
              // `attemptUpstreamModel` feeds the synthetic usage's
              // `upstream_model` (Finding #4).
              let attemptBodyBuf: Buffer = upstreamBodyBuf;
              let attemptUpstreamModel =
                resolution.upfront?.upstreamModel ?? requestedModel;
              if (resolution.upfront === null) {
                const ra = resolution.perAttempt(credential.type);
                attemptBodyBuf = rewriteUpstreamModel(upstreamBodyBuf, ra);
                attemptUpstreamModel = ra.upstreamModel;
                if (ra.wasAlias) {
                  applyAliasResolved(app, reply, ra, "openai");
                } else {
                  reply.removeHeader("x-caliber-resolved-model");
                }
              } else if (resolution.upfront) {
                const ra = resolution.perAttempt(credential.type);
                attemptBodyBuf = applyUpfrontDrift(
                  app,
                  upstreamBodyBuf,
                  resolution.upfront,
                  ra,
                  "openai",
                  { requestId, accountId: account.id },
                );
                attemptUpstreamModel = ra.upstreamModel;
                if (ra.upstreamModel !== resolution.upfront.upstreamModel) {
                  if (ra.wasAlias) {
                    reply.header("x-caliber-resolved-model", ra.upstreamModel);
                  } else {
                    reply.removeHeader("x-caliber-resolved-model");
                  }
                }
              }

              const upstream = await callUpstreamResponses({
                baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
                body: attemptBodyBuf,
                credential,
                signal: ac.signal,
              });

              if (upstream.kind === "stream") {
                throw { status: 502, message: "unexpected_stream" };
              }

              if (upstream.status < 200 || upstream.status >= 300) {
                throw buildUpstreamHttpError(upstream);
              }

              let openaiResp: unknown = null;
              let parseErr: unknown = null;
              try {
                openaiResp = JSON.parse(upstream.body.toString("utf8"));
              } catch (err) {
                parseErr = err;
                req.log.warn(
                  {
                    requestId,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "openai upstream 2xx body was not valid JSON",
                );
              }

              const translated = openaiResp
                ? translateResponsesResponseToChat(
                    openaiResp as Parameters<
                      typeof translateResponsesResponseToChat
                    >[0],
                  )
                : null;

              // Forensic-row contract (mirrors PR 9b/9d/9e/9g): emit
              // usage_log BEFORE the parse-failure throw so a malformed-
              // 2xx attempt leaves a zero-cost row recording which
              // account misbehaved. Build the synthetic Anthropic shape
              // directly from the translated Chat usage so
              // emitUsageLog's pricing column is populated unchanged.
              // `model` is the RESOLVED upstream id (Finding #4).
              const upstreamForLog = translated
                ? buildSyntheticAnthropicUsage({
                    id: `synthetic:openai-chat:${requestId}`,
                    model: attemptUpstreamModel,
                    inputTokens: translated.usage?.prompt_tokens ?? 0,
                    outputTokens: translated.usage?.completion_tokens ?? 0,
                  })
                : null;
              await emitUsageLog({
                app,
                req,
                requestedModel,
                accountId: account.id,
                upstreamResponse: upstreamForLog,
                platform: usageLogInboundPlatformForSurface("chat-completions"),
                surface: "chat-completions",
                statusCode: 200,
                durationMs: Date.now() - startedAtMs,
              });
              await emitBodyCapture({
                app,
                req,
                requestId,
                requestBodyJson: attemptBodyBuf.toString("utf8"),
                responseBody: translated,
                stream: false,
              });

              if (parseErr !== null) {
                throw { status: 502, message: "upstream_malformed_json" };
              }

              return translated;
            },
          ),
      }));

      const responseBuf = Buffer.from(JSON.stringify(chatResp));
      reply
        .code(200)
        .header("content-type", "application/json")
        .send(responseBuf);
      tryStoreOnSuccess(
        {
          redis: app.redis,
          ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
          onRedisError: () =>
            app.gwMetrics.redisErrorTotal.inc({ op: "cache_write" }),
        },
        cacheKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
      storeIdempotent(
        { redis: app.redis, ttlSec: opts.env.GATEWAY_IDEMPOTENCY_TTL_SEC },
        idemKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
    } catch (err) {
      if (err instanceof NoOwnUpstreamError) {
        reply
          .code(NO_OWN_UPSTREAM_STATUS)
          .send(noOwnUpstreamReplyBody(err.platform, requestId));
        return;
      }
      if (err instanceof AllUpstreamsFailed) {
        reply.code(503).send({
          error: "all_upstreams_failed",
          attempted_count: err.attemptedIds.length,
          request_id: requestId,
        });
        return;
      }
      if (err instanceof FatalUpstreamError) {
        reply
          .code(err.statusCode)
          .send(fatalUpstreamReplyBody(err, requestId));
        return;
      }
      throw err;
    } finally {
      req.raw.off("close", onClose);
    }
  };
}

async function runChatCompletionsOpenaiStreamingFailover(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  requestedModel: string,
  startedAtMs: number,
  resolution: ModelResolution,
): Promise<void> {
  reply.hijack();

  const upfrontUpstreamModel =
    resolution.upfront?.upstreamModel ?? requestedModel;

  // After `reply.hijack()` SSE headers are written via `reply.raw.writeHead`,
  // so the resolved-model header is threaded through this box. Single-bucket:
  // known up front. Mixed-bucket: filled per-attempt before the first byte.
  const resolvedModelHeader: { value: string | null } = {
    value:
      resolution.upfront && resolution.upfront.wasAlias
        ? resolution.upfront.upstreamModel
        : null,
  };
  const streamHeaders = (): Record<string, string> => ({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(resolvedModelHeader.value
      ? { "x-caliber-resolved-model": resolvedModelHeader.value }
      : {}),
  });

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.once("close", onClose);

  try {
    await runFailover(buildFailoverInput(req, app.db, {
      maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
      scheduler: app.gwScheduler,
      attempt: async (account) =>
        withSlotAndCredential(
          app,
          opts,
          account,
          requestId,
          async (credential) => {
            // Alias resolution against the LIVE credential bucket. Capture the
            // resolved id for the SSE header + synthetic usage upstream_model.
            //   * Mixed-bucket (`upfront === null`): rewrite per the runtime
            //     type; reset the header box per attempt (a failed alias
            //     attempt must not leak its id into a non-alias winner).
            //   * Single-bucket (`upfront !== null`): the row id is baked into
            //     `upstreamBodyBuf`; re-resolve and, on drift, rewrite to the
            //     credential-derived id + warn/metric (Finding 2) and re-point
            //     the SSE header box at what was actually sent upstream.
            let attemptBodyBuf: Buffer = upstreamBodyBuf;
            let attemptUpstreamModel = upfrontUpstreamModel;
            if (resolution.upfront === null) {
              const ra = resolution.perAttempt(credential.type);
              attemptBodyBuf = rewriteUpstreamModel(upstreamBodyBuf, ra);
              attemptUpstreamModel = ra.upstreamModel;
              // Reset per attempt: a prior failed attempt may have set the box;
              // if this (winning) attempt's bucket doesn't treat the model as an
              // alias, the header must NOT carry the earlier attempt's resolved id.
              resolvedModelHeader.value = ra.wasAlias ? ra.upstreamModel : null;
              if (ra.wasAlias) {
                app.gwMetrics.modelAliasResolvedTotal.inc({
                  platform: "openai",
                  family: ra.family ?? "",
                });
              }
            } else if (resolution.upfront) {
              const ra = resolution.perAttempt(credential.type);
              attemptBodyBuf = applyUpfrontDrift(
                app,
                upstreamBodyBuf,
                resolution.upfront,
                ra,
                "openai",
                { requestId, accountId: account.id },
              );
              attemptUpstreamModel = ra.upstreamModel;
              // Reset per attempt (not only on drift): on no-drift this
              // re-affirms the correct id; on drift it re-points the SSE header
              // at the credential-derived id the live call actually used.
              resolvedModelHeader.value = ra.wasAlias ? ra.upstreamModel : null;
            }

            const upstream = await callUpstreamResponses({
              baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
              body: attemptBodyBuf,
              credential,
              signal: ac.signal,
            });

            if (upstream.kind !== "stream") {
              throw {
                status: upstream.status,
                message:
                  upstream.status >= 400
                    ? upstream.body.toString("utf8").slice(0, 500)
                    : "expected_stream",
              };
            }

            if (upstream.status < 200 || upstream.status >= 300) {
              throw {
                status: upstream.status,
                message: `upstream_${upstream.status}`,
              };
            }

            // Capture the terminal `response.completed` event's usage
            // for the pricing path. Box via usageRef to dodge TS
            // closure-narrowing on assignments inside flushChunk.
            const usageRef: {
              current: ResponsesUsage | null;
            } = { current: null };

            if (!reply.raw.headersSent) {
              reply.raw.writeHead(200, streamHeaders());
            }

            const translator = makeResponsesToChatStream();
            const flushChunk = (chunk: OpenAIStreamChunk | "[DONE]"): void => {
              if (chunk === "[DONE]") {
                reply.raw.write("data: [DONE]\n\n");
                return;
              }
              reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
            };

            try {
              for await (const event of parseOpenAIResponsesSse(upstream.body, {
                strict: false,
                onError: (err) => {
                  req.log.warn(
                    { requestId, err: err.message },
                    "openai responses SSE parse error — skipping event",
                  );
                },
                onUnknownEvent: (eventName) => {
                  req.log.debug(
                    { requestId, eventName },
                    "openai responses SSE: unknown event type dropped",
                  );
                },
              })) {
                if (
                  event.type === "response.completed" &&
                  event.response.usage
                ) {
                  usageRef.current = event.response.usage;
                }
                for (const chunk of translator.onEvent(event)) {
                  flushChunk(chunk);
                }
              }
              for (const chunk of translator.onEnd()) flushChunk(chunk);
            } catch (err) {
              // Mid-stream error — emit a Chat-shaped error chunk.
              // Chat clients parse the `error` key from a data event.
              reply.raw.write(
                serializeChatSseError(
                  err instanceof Error ? err.name : "unknown",
                  err instanceof Error ? err.message : String(err),
                  requestId,
                ),
              );
            }

            reply.raw.end();

            // Pricing path: synthesize an Anthropic-shaped response
            // from the captured Responses usage so emitUsageLog's
            // pricing column is populated unchanged. Synthetic id
            // namespaced `synthetic:openai-stream-chat:` for ops
            // pivots by surface.
            const completedUsage = usageRef.current;
            const cachedTokens =
              completedUsage?.input_tokens_details?.cached_tokens ?? 0;
            const upstreamForLog = completedUsage
              ? buildSyntheticAnthropicUsage({
                  id: `synthetic:openai-stream-chat:${requestId}`,
                  // RESOLVED upstream id (Finding #4), not the alias.
                  model: attemptUpstreamModel,
                  inputTokens: Math.max(
                    0,
                    completedUsage.input_tokens - cachedTokens,
                  ),
                  outputTokens: completedUsage.output_tokens,
                  cacheReadInputTokens: cachedTokens,
                })
              : null;
            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse: upstreamForLog,
              platform: usageLogInboundPlatformForSurface("chat-completions"),
              surface: "chat-completions",
              statusCode: 200,
              durationMs: Date.now() - startedAtMs,
            });
            await emitBodyCapture({
              app,
              req,
              requestId,
              requestBodyJson: attemptBodyBuf.toString("utf8"),
              responseBody: null,
              stream: true,
            });
            return undefined as never;
          },
        ),
    }));
  } catch (err) {
    respondStreamFailoverCollapse(reply, err, requestId, serializeChatSseError);
  } finally {
    req.raw.removeListener("close", onClose);
  }
}
