import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
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
} from "@aide/gateway-core";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
} from "../runtime/failoverLoop.js";
import {
  checkRouteCache,
  tryStoreOnSuccess,
} from "../runtime/responseCache.js";
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
} from "../runtime/sseErrorEvents.js";
import { autoRoute } from "./dispatch.js";

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
    // For the streaming path we need the upstream to also stream — set
    // `stream: true` on the translated Anthropic body so
    // `callUpstreamMessages` requests text/event-stream.
    const upstreamBody = isStream
      ? { ...anthropicBody, stream: true }
      : anthropicBody;
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));

    // Phase 3 #2 — cache scope `v1/chat/completions` keyed on the
    // CLIENT body (openai-chat shape), shared across this handler and
    // the openai-platform branch so a reconfigured group hits the same
    // cache. Skipped for streaming.
    const clientBodyBuf = Buffer.from(JSON.stringify(body));
    let cacheKey: string | null = null;
    if (!isStream) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/chat/completions",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
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
        body.model,
      );
      return;
    }

    // Capture start time BEFORE the failover loop so durationMs includes
    // request translation + credential resolve + slot acquire + failover
    // switches. See usageLogging.ts for payload semantics.
    const startedAtMs = Date.now();
    // Pull client-requested model from the already-validated body. This
    // is the OpenAI model name (e.g., "gpt-4") the client sent — distinct
    // from the Anthropic upstream model that comes back in `parsed.model`.
    const requestedModel = body.model;

    try {
      const openaiResponse = await runFailover({
        db: app.db,
        orgId: req.apiKey.orgId,
        teamId: req.apiKey.teamId,
        groupId: req.apiKey?.groupId ?? null,
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
          );
          if (!acquired) {
            // Treat as a transient failure so failover loop tries another account.
            throw { status: 503, message: "account_at_capacity" };
          }
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
                },
              );
            }

            const result = await callUpstreamMessages({
              baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
              body: upstreamBodyBuf,
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
              requestBodyJson: upstreamBodyBuf.toString("utf8"),
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
            await releaseSlot(
              app.redis,
              "account",
              account.id,
              requestId,
            ).catch(() => {
              // Intentionally swallowed — slot expires on its own within SLOT_DURATION_MS.
            });
          }
        },
      });

      const responseBuf = Buffer.from(JSON.stringify(openaiResponse));
      reply
        .code(200)
        .header("content-type", "application/json")
        .send(responseBuf);
      tryStoreOnSuccess(
        { redis: app.redis, ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC },
        cacheKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
    } catch (err) {
      if (err instanceof AllUpstreamsFailed) {
        reply.code(503).send({
          error: "all_upstreams_failed",
          attempted_count: err.attemptedIds.length,
          request_id: requestId,
        });
        return;
      }
      if (err instanceof FatalUpstreamError) {
        reply.code(err.statusCode).send({
          error: err.reason,
          request_id: requestId,
        });
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
): Promise<void> {
  reply.hijack();
  const startedAtMs = Date.now();

  // Wire AbortSignal from client disconnect so a hung upstream is cancelled.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.once("close", onClose);

  try {
    await runFailover({
      db: app.db,
      orgId: req.apiKey!.orgId,
      teamId: req.apiKey!.teamId,
      groupId: req.apiKey?.groupId ?? null,
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
        );
        if (!acquired) {
          throw { status: 503, message: "account_at_capacity" };
        }

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
              },
            );
          }

          const upstream = await callUpstreamMessages({
            baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
            body: upstreamBodyBuf,
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
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
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
            requestBodyJson: upstreamBodyBuf.toString("utf8"),
            responseBody: null,
            stream: true,
          });
          return undefined as never;
        } finally {
          await releaseSlot(app.redis, "account", account.id, requestId).catch(
            () => {
              // Slot expires on its own.
            },
          );
        }
      },
    });
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
    // Mirror the messages-openai pattern: the upstream needs `stream:
    // true` to return text/event-stream; the client-facing flag is
    // already mirrored on `body.stream`.
    const upstreamBody = isStream
      ? { ...responsesBody, stream: true }
      : responsesBody;
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));
    const startedAtMs = Date.now();
    const requestedModel = body.model;

    // Phase 3 #2 — same scope as the anthropic-platform handler so a
    // group reconfigure doesn't invalidate.
    const clientBodyBuf = Buffer.from(JSON.stringify(body));
    let cacheKey: string | null = null;
    if (!isStream) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/chat/completions",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
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
      );
      return;
    }

    // AbortSignal from client disconnect → upstream cancel. Without
    // it a hung OpenAI call holds upstream resources up to 60s.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.once("close", onClose);

    try {
      const chatResp = await runFailover({
        db: app.db,
        orgId: req.apiKey.orgId,
        teamId: req.apiKey.teamId,
        groupId: req.apiKey?.groupId ?? null,
        maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
        scheduler: app.gwScheduler,
        attempt: async (account) =>
          withSlotAndCredential(
            app,
            opts,
            account,
            requestId,
            async (credential) => {
              const upstream = await callUpstreamResponses({
                baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
                body: upstreamBodyBuf,
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
              const upstreamForLog = translated
                ? buildSyntheticAnthropicUsage({
                    id: `synthetic:openai-chat:${requestId}`,
                    model: requestedModel,
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
                requestBodyJson: upstreamBodyBuf.toString("utf8"),
                responseBody: translated,
                stream: false,
              });

              if (parseErr !== null) {
                throw { status: 502, message: "upstream_malformed_json" };
              }

              return translated;
            },
          ),
      });

      const responseBuf = Buffer.from(JSON.stringify(chatResp));
      reply
        .code(200)
        .header("content-type", "application/json")
        .send(responseBuf);
      tryStoreOnSuccess(
        { redis: app.redis, ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC },
        cacheKey,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBuf,
        },
      );
    } catch (err) {
      if (err instanceof AllUpstreamsFailed) {
        reply.code(503).send({
          error: "all_upstreams_failed",
          attempted_count: err.attemptedIds.length,
          request_id: requestId,
        });
        return;
      }
      if (err instanceof FatalUpstreamError) {
        reply.code(err.statusCode).send({
          error: err.reason,
          request_id: requestId,
        });
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
): Promise<void> {
  reply.hijack();

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.once("close", onClose);

  try {
    await runFailover({
      db: app.db,
      orgId: req.apiKey!.orgId,
      teamId: req.apiKey!.teamId,
      groupId: req.apiKey?.groupId ?? null,
      maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
      scheduler: app.gwScheduler,
      attempt: async (account) =>
        withSlotAndCredential(
          app,
          opts,
          account,
          requestId,
          async (credential) => {
            const upstream = await callUpstreamResponses({
              baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
              body: upstreamBodyBuf,
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
              reply.raw.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
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
                  model: requestedModel,
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
              requestBodyJson: upstreamBodyBuf.toString("utf8"),
              responseBody: null,
              stream: true,
            });
            return undefined as never;
          },
        ),
    });
  } catch (err) {
    respondStreamFailoverCollapse(reply, err, requestId, serializeChatSseError);
  } finally {
    req.raw.removeListener("close", onClose);
  }
}
