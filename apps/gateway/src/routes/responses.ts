// `/v1/responses` route handler — Plan 5A Part 9 Task 9.3 (Anthropic
// upstream slice).
//
// Accepts OpenAI Responses-format request bodies, validates against the
// `ResponsesRequestSchema` Zod schema (gated by design A6 — text +
// function-calling subset only), and dispatches based on the resolved
// group platform:
//
//   * `group.platform === "anthropic"`: translates the body to
//     Anthropic Messages, runs the same failover loop the existing
//     `/v1/messages` and `/v1/chat/completions` routes use, then
//     translates the upstream Anthropic response back to Responses
//     shape.
//   * `group.platform === "openai"`: body passthrough through
//     `runOpenaiResponsesPassthroughFailover` (non-stream) or
//     `runOpenaiResponsesStreamingPassthrough` (stream=true). Wired in
//     by PR #45 and verified end-to-end against an OpenAI-compat
//     upstream in v0.4.2 (curl + codex CLI both green).
//
// Streaming for the openai-platform passthrough is supported (see
// `runOpenaiResponsesStreamingPassthrough` below). The Anthropic-platform
// translator branch is also streaming-capable via
// `makeAnthropicToResponsesStream`.
//
// Per design §A6 the schema explicitly accepts `previous_response_id`
// (we use it for sticky scheduling — Layer 1 in the scheduler) but
// rejects everything else not enumerated by the schema via `.strict()`.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
import {
  ResponsesRequestSchema,
  translateResponsesToAnthropic,
  translateAnthropicResponseToResponses,
  makeAnthropicToResponsesStream,
  parseAnthropicSse,
  parseOpenAIResponsesSse,
  extractResponsesUsage,
  type ResponsesSSEEvent,
} from "@aide/gateway-core";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
} from "../runtime/failoverLoop.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { callUpstreamResponses } from "../runtime/upstreamCallOpenai.js";
import {
  checkRouteCache,
  tryStoreOnSuccess,
} from "../runtime/responseCache.js";
import { emitUsageLog } from "../runtime/usageLogging.js";
import { emitBodyCapture } from "../runtime/bodyCapture.js";
import { buildSyntheticAnthropicUsage } from "../runtime/syntheticUsageShapes.js";
import { withSlotAndCredential } from "../runtime/withSlotAndCredential.js";
import { buildUpstreamHttpError } from "../runtime/upstreamErrorMapping.js";
import {
  serializeResponsesSseError,
  respondStreamFailoverCollapse,
  fatalUpstreamReplyBody,
} from "../runtime/sseErrorEvents.js";
import type {
  NonStreamUpstreamResult,
  UpstreamResult,
} from "../runtime/upstreamCall.js";

// Type-narrowing helper used by the streaming attempt callback when
// the upstream call surprisingly returns non-stream (e.g. on 4xx).
function expectNonStream(upstream: UpstreamResult): NonStreamUpstreamResult {
  if (upstream.kind === "stream") {
    throw { status: 502, message: "unexpected_stream" };
  }
  return upstream;
}

export interface ResponsesRouteOptions {
  env: ServerEnv;
}

/**
 * Per design §9.4 — the schema's `.strict()` already rejects unknown
 * keys at the Zod layer, but a few tools (and curl one-liners) supply
 * features that map cleanly to other Zod errors (e.g. `parameters` on
 * a non-function tool). We list the explicit out-of-scope flags here
 * so error messages name them, instead of "unrecognized_keys".
 */
const EXPLICIT_UNSUPPORTED_FIELDS = [
  "file_search",
  "code_interpreter",
  "computer_use",
] as const;

/**
 * Fields codex CLI / openai SDK send unconditionally on every
 * `/v1/responses` call, but which aide doesn't currently forward
 * upstream. Stripped pre-Zod so `.strict()` doesn't 400 the request.
 *
 * Trade-off (acknowledged): on the OpenAI passthrough path these
 * flags have real upstream semantics; silently dropping them means a
 * client that explicitly disabled e.g. `parallel_tool_calls: false`
 * gets the upstream's default behaviour instead. In practice both
 * codex CLI and the OpenAI default sit on the permissive side
 * (`parallel_tool_calls: true`, no `reasoning`, `store: true`), so
 * drop ≈ no-op for the dominant case.
 *
 * Long-term fix (tracked separately): add these fields to
 * `ResponsesRequestSchema` and forward them on the OpenAI passthrough
 * path so client intent is preserved when it diverges from the upstream
 * default. The Anthropic translator branch will keep dropping them
 * because Anthropic Messages has no equivalent.
 */
const SILENTLY_DROPPED_FIELDS = [
  "store",
  "parallel_tool_calls",
  "reasoning",
] as const;

/**
 * Core handler for the OpenAI Responses surface — exported so the
 * Codex CLI alias route (`/backend-api/codex/responses` + subpath)
 * can wrap it with `forcePlatform("openai")` instead of duplicating
 * the body. The handler dispatches by `req.gwGroupContext.platform`
 * just like the inline `/v1/responses` registration does.
 */
export function makeResponsesRouteHandler(
  app: FastifyInstance,
  opts: ResponsesRouteOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.apiKey || !req.gwUser || !req.gwOrg) {
      reply.code(401).send({ error: "missing_api_key" });
      return;
    }

    const ctx = req.gwGroupContext;
    if (!ctx) {
      // groupContextPlugin should have either set ctx or 403'd before
      // this handler runs — defense-in-depth.
      reply.code(403).send({ error: "group_required" });
      return;
    }

    const rawBody = req.body as Record<string, unknown> | undefined;
    if (!rawBody || typeof rawBody !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    // ── Dispatch by platform ────────────────────────────────────────
    // The Anthropic translator branch needs strict Zod validation to
    // safely transform the body. The OpenAI passthrough branch does
    // not — aide forwards the body verbatim to the OpenAI-compatible
    // upstream, which owns request validation. Skipping the schema on
    // the passthrough path lets aide stay compatible with codex CLI /
    // openai SDK as they evolve (new tools like `web_search` /
    // `local_shell`, new top-level fields like `include` / `text` /
    // `prompt_cache_key` / `client_metadata`) without aide needing to
    // model every shape upstream introduces.

    if (ctx.platform === "openai") {
      const modelRaw = rawBody.model;
      if (typeof modelRaw !== "string" || modelRaw.length === 0) {
        reply.code(400).send({
          error: "invalid_request",
          detail: "`model` is required",
        });
        return;
      }
      const stream = rawBody.stream === true;

      // Cache key uses the raw client body so a verbatim repeat (e.g.
      // codex retry on transient failure) hits the cache.
      const clientBodyBuf = Buffer.from(JSON.stringify(rawBody));
      let cacheKey: string | null = null;
      if (!stream) {
        const result = await checkRouteCache({
          redis: app.redis,
          ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
          orgId: req.gwOrg.id,
          scope: "v1/responses",
          bodyBuf: clientBodyBuf,
          reply,
          onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
        });
        if (result.hit) return;
        cacheKey = result.cacheKey;
      }

      if (stream) {
        await runOpenaiResponsesStreamingPassthrough(
          app,
          opts,
          req,
          reply,
          rawBody,
          req.id,
          modelRaw,
        );
        return;
      }
      await runOpenaiResponsesPassthroughFailover(
        app,
        opts,
        req,
        reply,
        rawBody,
        req.id,
        modelRaw,
        cacheKey,
      );
      return;
    }

    if (ctx.platform !== "anthropic") {
      // gemini / antigravity not in 5A scope; clear deferral signal.
      reply.code(503).send({
        error: "platform_not_yet_wired",
        platform: ctx.platform,
      });
      return;
    }

    // ── Anthropic translator path: strict schema needed ────────────
    // Strip no-op fields some clients send unconditionally (codex CLI's
    // `store`, `parallel_tool_calls`, `reasoning`) before they hit
    // `.strict()`. Done first so the explicit reject list and Zod see
    // the same body the translator will actually process.
    const sanitizedBody: Record<string, unknown> = { ...rawBody };
    for (const key of SILENTLY_DROPPED_FIELDS) {
      delete sanitizedBody[key];
    }

    // Surface the design-A6 reject list with clear field names before
    // Zod's "unrecognized_keys" — friendlier for curl users.
    for (const key of EXPLICIT_UNSUPPORTED_FIELDS) {
      if (sanitizedBody[key] !== undefined) {
        reply.code(400).send({
          error: "unsupported_feature",
          field: key,
        });
        return;
      }
    }

    const parsed = ResponsesRequestSchema.safeParse(sanitizedBody);
    if (!parsed.success) {
      reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
          code: i.code,
        })),
      });
      return;
    }
    const body = parsed.data;

    // Cache scope `v1/responses` keyed on the Zod-validated body.
    const clientBodyBuf = Buffer.from(JSON.stringify(body));
    let cacheKey: string | null = null;
    if (body.stream !== true) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/responses",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
      });
      if (result.hit) return;
      cacheKey = result.cacheKey;
    }

    // Translate Responses request → Anthropic shape.  The translator is
    // expected to be total over a Zod-validated input, so a throw here
    // signals a translator bug or a schema-translator drift — surface
    // as 502 (gateway error) rather than 400 (user error).  The route's
    // top-level try/catch wraps `runFailover`; we handle this case
    // separately because we haven't entered the failover loop yet.
    let anthropicBody;
    try {
      anthropicBody = translateResponsesToAnthropic(body);
    } catch (err) {
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "translateResponsesToAnthropic threw on a Zod-validated body — translator bug or schema drift",
      );
      reply.code(502).send({
        error: "translator_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const requestId = req.id;
    const isStream = body.stream === true;
    const upstreamBody = isStream
      ? { ...anthropicBody, stream: true }
      : anthropicBody;
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));

    if (isStream) {
      await runResponsesStreamingFailover(
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

    const startedAtMs = Date.now();
    const requestedModel = body.model;

    try {
      const responsesResp = await runFailover({
        db: app.db,
        orgId: req.apiKey.orgId,
        teamId: req.apiKey.teamId,
        groupId: req.apiKey?.groupId ?? null,
        platform: req.gwGroupContext!.platform,
        maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
        scheduler: app.gwScheduler,
        attempt: async (account) =>
          withSlotAndCredential(
            app,
            opts,
            account,
            requestId,
            async (credential) => {
              const upstream = await callUpstreamMessages({
                baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
                body: upstreamBodyBuf,
                credential,
              });

              if (upstream.kind === "stream") {
                throw { status: 502, message: "unexpected_stream" };
              }

              if (upstream.status < 200 || upstream.status >= 300) {
                throw buildUpstreamHttpError(upstream);
              }

              // Parse defensively — emit a forensic zero-usage log on
              // parse failure, then 502 the client.
              let anthropicResp: unknown = null;
              let parseErr: unknown = null;
              try {
                anthropicResp = JSON.parse(upstream.body.toString("utf8"));
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

              await emitUsageLog({
                app,
                req,
                requestedModel,
                accountId: account.id,
                upstreamResponse: anthropicResp,
                platform: "openai",
                surface: "responses",
                statusCode: 200,
                durationMs: Date.now() - startedAtMs,
              });
              await emitBodyCapture({
                app,
                req,
                requestId,
                requestBodyJson: upstreamBodyBuf.toString("utf8"),
                responseBody: anthropicResp,
                stream: false,
              });

              if (parseErr !== null) {
                throw { status: 502, message: "upstream_malformed_json" };
              }

              return translateAnthropicResponseToResponses(
                anthropicResp as Parameters<
                  typeof translateAnthropicResponseToResponses
                >[0],
              );
            },
          ),
      });

      const responseBuf = Buffer.from(JSON.stringify(responsesResp));
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
        reply
          .code(err.statusCode)
          .send(fatalUpstreamReplyBody(err, requestId));
        return;
      }
      throw err;
    }
  };
}

export async function responsesRoutes(
  app: FastifyInstance,
  opts: ResponsesRouteOptions,
): Promise<void> {
  app.post("/v1/responses", makeResponsesRouteHandler(app, opts));
}

// ---------------------------------------------------------------------------
// Streaming path (Plan 5A PR 9c).
//
// Translates `stream: true` /v1/responses requests into streaming
// Anthropic upstream calls, parses upstream Anthropic SSE via
// `parseAnthropicSse`, runs each event through
// `makeAnthropicToResponsesStream`, and serializes Responses SSE events
// (`event: <type>\ndata: <json>\n\n`) to the client.
//
// Captures the terminal `response.completed` event's usage block so the
// existing pricing path runs unchanged via `emitUsageLog` (translated
// back to a synthetic Anthropic-shape).
// ---------------------------------------------------------------------------

async function runResponsesStreamingFailover(
  app: FastifyInstance,
  opts: ResponsesRouteOptions,
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
      platform: req.gwGroupContext!.platform,
      maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
      scheduler: app.gwScheduler,
      attempt: async (account) =>
        withSlotAndCredential(
          app,
          opts,
          account,
          requestId,
          async (credential) => {
            const upstream = await callUpstreamMessages({
              baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
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

            // Capture the terminal `response.completed` event's usage so
            // the pricing path can run after the stream closes. Stream
            // events are flushed to the client as soon as they arrive.
            let completedUsage: {
              input_tokens: number;
              output_tokens: number;
              cached_tokens: number;
            } | null = null;

            if (!reply.raw.headersSent) {
              reply.raw.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
            }

            const translator = makeAnthropicToResponsesStream();
            const flushEvent = (ev: ResponsesSSEEvent): void => {
              if (ev.type === "response.completed" && ev.response.usage) {
                completedUsage = {
                  input_tokens: ev.response.usage.input_tokens,
                  output_tokens: ev.response.usage.output_tokens,
                  cached_tokens:
                    ev.response.usage.input_tokens_details?.cached_tokens ?? 0,
                };
              }
              // Responses SSE uses named events — `event: <type>\ndata: …`.
              reply.raw.write(
                `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`,
              );
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
                for (const ev of translator.onEvent(event)) flushEvent(ev);
              }
              for (const ev of translator.onEnd()) flushEvent(ev);
            } catch (err) {
              for (const ev of translator.onError({
                kind: err instanceof Error ? err.name : "unknown",
                message: err instanceof Error ? err.message : String(err),
              })) {
                flushEvent(ev);
              }
            }

            reply.raw.end();

            // Translate the captured Responses-shape usage back to a
            // synthetic Anthropic response so emitUsageLog's pricing path
            // runs unchanged. Cache fields default to zero — the streaming
            // Anthropic API surfaces `cache_read_input_tokens` only on
            // message_start, which `makeAnthropicToResponsesStream` already
            // folded into `input_tokens_details.cached_tokens`.
            const upstreamResponse = completedUsage
              ? syntheticAnthropicFromResponsesUsage(
                  completedUsage,
                  requestedModel,
                  requestId,
                )
              : null;
            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse,
              platform: "openai",
              surface: "responses",
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
    respondStreamFailoverCollapse(
      reply,
      err,
      requestId,
      serializeResponsesSseError,
    );
  } finally {
    req.raw.removeListener("close", onClose);
  }
}

/**
 * Adapter from the Responses SSE terminal usage shape into the shared
 * synthetic Anthropic shape consumed by `emitUsageLog`'s pricing path.
 * Responses `input_tokens` is the gross count (cached + non-cached);
 * the pricing path expects Anthropic's split (non-cached in
 * `input_tokens`, cached in `cache_read_input_tokens`).
 */
function syntheticAnthropicFromResponsesUsage(
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  model: string,
  requestId: string,
): ReturnType<typeof buildSyntheticAnthropicUsage> {
  return buildSyntheticAnthropicUsage({
    id: `synthetic:anthropic-stream:${requestId}`,
    model,
    inputTokens: Math.max(0, usage.input_tokens - usage.cached_tokens),
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cached_tokens,
  });
}

// ---------------------------------------------------------------------------
// OpenAI-upstream passthrough path (Plan 5A PR 9d).
//
// When `group.platform === "openai"` and the inbound route is also
// `/v1/responses`, the client and upstream speak the same format —
// body passthrough.  Auth headers + endpoint URL differ from the
// Anthropic helper (Bearer token, `/v1/responses` on api.openai.com),
// so we use `callUpstreamResponses`.  Reuses the same failover loop /
// scheduler / slot semantics.
//
// Streaming for the openai-platform passthrough is implemented in
// `runOpenaiResponsesStreamingPassthrough` below — it reads the SSE
// chunks from the upstream and pipes them straight back to the client,
// observing the terminal `response.completed` event to harvest usage
// for the post-stream pricing path.
//
// Usage extraction: OpenAI's Responses non-stream response shape
// surfaces `usage.input_tokens` + `output_tokens` (+ optional
// `input_tokens_details.cached_tokens`).  We translate that to the
// shared synthetic Anthropic shape so emitUsageLog's pricing path runs
// unchanged.
// ---------------------------------------------------------------------------

async function runOpenaiResponsesPassthroughFailover(
  app: FastifyInstance,
  opts: ResponsesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, unknown>,
  requestId: string,
  requestedModel: string,
  cacheKey: string | null,
): Promise<void> {
  const startedAtMs = Date.now();
  const upstreamBodyBuf = Buffer.from(JSON.stringify(body));

  // Wire AbortSignal from client disconnect → upstream cancel.
  // Same plumbing as the streaming helpers; without this, a hung
  // OpenAI call holds upstream resources for up to 60s after the
  // client gives up.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.raw.once("close", onClose);

  try {
    const responsesResp = await runFailover({
      db: app.db,
      orgId: req.apiKey!.orgId,
      teamId: req.apiKey!.teamId,
      groupId: req.apiKey?.groupId ?? null,
      platform: req.gwGroupContext!.platform,
      maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
      scheduler: app.gwScheduler,
      attempt: async (account) =>
        withSlotAndCredential(
          app,
          opts,
          account,
          requestId,
          async (credential) => {
            const upstream = expectNonStream(
              await callUpstreamResponses({
                baseUrl: opts.env.UPSTREAM_OPENAI_BASE_URL,
                body: upstreamBodyBuf,
                credential,
                signal: ac.signal,
              }),
            );

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

            // Translate OpenAI usage → synthetic Anthropic shape so
            // emitUsageLog's pricing path runs unchanged.
            const usage = extractResponsesUsage(openaiResp);
            const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
            const upstreamForLog = usage
              ? buildSyntheticAnthropicUsage({
                  id: `synthetic:openai-passthrough:${requestId}`,
                  model: requestedModel,
                  inputTokens: Math.max(0, usage.input_tokens - cached),
                  outputTokens: usage.output_tokens,
                  cacheReadInputTokens: cached,
                })
              : null;

            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse: upstreamForLog,
              platform: "openai",
              surface: "responses",
              statusCode: 200,
              durationMs: Date.now() - startedAtMs,
            });
            await emitBodyCapture({
              app,
              req,
              requestId,
              requestBodyJson: upstreamBodyBuf.toString("utf8"),
              responseBody: openaiResp,
              stream: false,
            });

            if (parseErr !== null) {
              throw { status: 502, message: "upstream_malformed_json" };
            }

            return openaiResp;
          },
        ),
    });

    const responseBuf = Buffer.from(JSON.stringify(responsesResp));
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
      reply
        .code(err.statusCode)
        .send(fatalUpstreamReplyBody(err, requestId));
      return;
    }
    throw err;
  } finally {
    req.raw.off("close", onClose);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-upstream streaming passthrough (Plan 5A PR 9e).
//
// Same shape as the non-stream openai passthrough — body forwarded
// verbatim, response forwarded verbatim — but byte-by-byte: parse the
// upstream Responses SSE via `parseOpenAIResponsesSse`, re-serialize
// each event to SSE bytes for the client, and watch for the terminal
// `response.completed` event to extract usage for the pricing path.
//
// We don't tee/shadow the byte stream because (a) we need to detect
// the terminal event to write the usage_log row anyway, (b) parsing
// + re-serialising is O(event count) with no measurable overhead vs
// raw passthrough, and (c) it lets the route observe protocol
// errors and surface them to the client in the same SSE-shaped form
// the SDK expects.
// ---------------------------------------------------------------------------

async function runOpenaiResponsesStreamingPassthrough(
  app: FastifyInstance,
  opts: ResponsesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, unknown>,
  requestId: string,
  requestedModel: string,
): Promise<void> {
  reply.hijack();
  const startedAtMs = Date.now();
  const upstreamBodyBuf = Buffer.from(JSON.stringify(body));

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
      platform: req.gwGroupContext!.platform,
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
            // so the pricing path can run after the stream closes.
            // Stream events are flushed to the client as soon as they
            // arrive.  `usageRef` boxing avoids TS's closure-narrowing
            // confusion (assignments inside `flushEvent` would
            // otherwise re-narrow to `never` at the read site).
            const usageRef: {
              current: {
                input_tokens: number;
                output_tokens: number;
                cached_tokens: number;
              } | null;
            } = { current: null };

            if (!reply.raw.headersSent) {
              reply.raw.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
            }

            const flushEvent = (ev: ResponsesSSEEvent): void => {
              if (ev.type === "response.completed" && ev.response.usage) {
                usageRef.current = {
                  input_tokens: ev.response.usage.input_tokens,
                  output_tokens: ev.response.usage.output_tokens,
                  cached_tokens:
                    ev.response.usage.input_tokens_details?.cached_tokens ?? 0,
                };
              }
              reply.raw.write(
                `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`,
              );
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
                flushEvent(event);
              }
            } catch (err) {
              // Mid-stream error: surface as an SSE error event in the
              // same shape the SDK consumer would parse from real
              // upstream errors, then close cleanly.
              reply.raw.write(
                serializeResponsesSseError(
                  err instanceof Error ? err.name : "unknown",
                  err instanceof Error ? err.message : String(err),
                  requestId,
                ),
              );
            }

            reply.raw.end();

            // Pricing path: synthetic Anthropic shape from the
            // captured Responses usage.
            const completedUsage = usageRef.current;
            const upstreamForLog = completedUsage
              ? buildSyntheticAnthropicUsage({
                  id: `synthetic:openai-stream:${requestId}`,
                  model: requestedModel,
                  inputTokens: Math.max(
                    0,
                    completedUsage.input_tokens - completedUsage.cached_tokens,
                  ),
                  outputTokens: completedUsage.output_tokens,
                  cacheReadInputTokens: completedUsage.cached_tokens,
                })
              : null;
            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse: upstreamForLog,
              platform: "openai",
              surface: "responses",
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
    respondStreamFailoverCollapse(
      reply,
      err,
      requestId,
      serializeResponsesSseError,
    );
  } finally {
    req.raw.removeListener("close", onClose);
  }
}
