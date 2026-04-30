import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
import {
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  makeAnthropicToChatStream,
  parseAnthropicSse,
  type OpenAIStreamChunk,
} from "@aide/gateway-core";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
} from "../runtime/failoverLoop.js";
import { resolveCredential } from "../runtime/resolveCredential.js";
import { maybeRefreshOAuth } from "../runtime/oauthRefresh.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";
import { emitUsageLog } from "../runtime/usageLogging.js";
import { emitBodyCapture } from "../runtime/bodyCapture.js";
import { buildSyntheticAnthropicUsage } from "../runtime/syntheticUsageShapes.js";

export interface ChatCompletionsRouteOptions {
  env: ServerEnv;
}

/** Safety-net expiry: slot key expires in Redis even if release is missed. */
const SLOT_DURATION_MS = 60_000;

export async function chatCompletionsRoutes(
  app: FastifyInstance,
  opts: ChatCompletionsRouteOptions,
): Promise<void> {
  app.post(
    "/v1/chat/completions",
    async (req: FastifyRequest, reply: FastifyReply) => {
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
                const text = result.body.toString("utf8");
                const retryAfterRaw = result.headers["retry-after"];
                const retryAfter =
                  typeof retryAfterRaw === "string"
                    ? parseInt(retryAfterRaw, 10)
                    : Array.isArray(retryAfterRaw)
                      ? parseInt(retryAfterRaw[0]!, 10)
                      : undefined;
                throw {
                  status: result.status,
                  retryAfter: Number.isNaN(retryAfter) ? undefined : retryAfter,
                  message: text.slice(0, 500),
                };
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

        reply
          .code(200)
          .header("content-type", "application/json")
          .send(openaiResponse);
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
    },
  );
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
    if (
      err instanceof AllUpstreamsFailed ||
      err instanceof FatalUpstreamError
    ) {
      // Headers already sent (we wrote them on the first chunk attempt) →
      // append a synthetic SSE error event.  If we never got far enough
      // to write headers (failover blew up at credential resolution
      // etc.), fall through to a JSON error response.
      if (reply.raw.headersSent) {
        reply.raw.write(
          `data: ${JSON.stringify({
            error:
              err instanceof FatalUpstreamError
                ? err.reason
                : "all_upstreams_failed",
            request_id: requestId,
          })}\n\n`,
        );
        reply.raw.end();
      } else {
        reply.raw.writeHead(
          err instanceof FatalUpstreamError ? err.statusCode : 503,
          { "content-type": "application/json" },
        );
        reply.raw.end(
          JSON.stringify({
            error:
              err instanceof FatalUpstreamError
                ? err.reason
                : "all_upstreams_failed",
            request_id: requestId,
          }),
        );
      }
      return;
    }
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: "internal_error" }));
    } else {
      reply.raw.end();
    }
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
