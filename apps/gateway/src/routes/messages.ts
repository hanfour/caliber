import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
import {
  translateAnthropicToResponses,
  translateResponsesResponseToAnthropic,
  parseOpenAIResponsesSse,
  makeResponsesToAnthropicStream,
  type AnthropicMessagesRequest,
  type AnthropicSSEEvent,
  type ResponsesUsage,
} from "@aide/gateway-core";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
} from "../runtime/failoverLoop.js";
import { resolveCredential } from "../runtime/resolveCredential.js";
import { maybeRefreshOAuth } from "../runtime/oauthRefresh.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { callUpstreamResponses } from "../runtime/upstreamCallOpenai.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";
import { SmartBuffer } from "../runtime/smartBuffer.js";
import {
  StreamUsageExtractor,
  type StreamUsageSnapshot,
} from "../runtime/streamUsageExtractor.js";
import type { SelectedAccount } from "../runtime/selectAccount.js";
import { emitUsageLog } from "../runtime/usageLogging.js";
import { emitBodyCapture } from "../runtime/bodyCapture.js";
import { withSlotAndCredential } from "../runtime/withSlotAndCredential.js";
import { usageLogInboundPlatformForSurface } from "../runtime/usageLogging.js";
import { buildSyntheticAnthropicUsage } from "../runtime/syntheticUsageShapes.js";
import {
  parseRetryAfterHeader,
  buildUpstreamHttpError,
} from "../runtime/upstreamErrorMapping.js";
import {
  serializeAnthropicSseError,
  respondStreamFailoverCollapse,
} from "../runtime/sseErrorEvents.js";
import { autoRoute } from "./dispatch.js";
import {
  checkRouteCache,
  tryStoreOnSuccess,
} from "../runtime/responseCache.js";

export interface MessagesRouteOptions {
  env: ServerEnv;
}

/** Safety-net expiry: slot key expires in Redis even if release is missed. */
const SLOT_DURATION_MS = 60_000;

const HOP_BY_HOP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Thrown from within the attempt callback when no concurrency slot is available.
 * Classified as a fatal "capacity" error so the outer catch can produce a 503
 * with the expected `account_at_capacity` error code.
 */
class CapacityError extends Error {
  constructor() {
    super("account_at_capacity");
    this.name = "CapacityError";
  }
}

/**
 * Core 4A handler for the Anthropic surface — extracted into a factory
 * so the autoRoute wrap (Plan 5A PR 9g) can dispatch by group platform
 * to either this handler (anthropic upstream) or
 * `makeMessagesOpenaiHandler` (cross-format → openai upstream).
 *
 * Body unchanged from the original inline handler; the only difference
 * is that it returns a closure instead of being registered directly.
 */
export function makeMessagesAnthropicHandler(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
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

    // Step 2 early-exit: model must be present before any DB/Redis work.
    if (typeof body.model !== "string" || body.model.length === 0) {
      reply.code(400).send({ error: "missing_model" });
      return;
    }

    const isStream = body.stream === true;
    const requestId = req.id; // Fastify auto-generates UUID per request.
    const upstreamBodyBuf = Buffer.from(JSON.stringify(body));

    // Phase 3 #2 — response cache for non-streaming requests. Disabled
    // when GATEWAY_CACHE_TTL_SEC=0 (default).  Scope `v1/messages`
    // identifies the public endpoint so cached entries don't collide
    // with bodies sent to other routes.
    let cacheKey: string | null = null;
    if (!isStream) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/messages",
        bodyBuf: upstreamBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
      });
      if (result.hit) return;
      cacheKey = result.cacheKey;
    }

    // Wire AbortSignal from client disconnect.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.once("close", onClose);

    try {
      if (isStream) {
        await runStreamingFailover(
          app,
          opts,
          req,
          reply,
          upstreamBodyBuf,
          requestId,
          ac.signal,
        );
      } else {
        await runNonStreamFailover(
          app,
          opts,
          req,
          reply,
          upstreamBodyBuf,
          requestId,
          ac.signal,
          cacheKey,
        );
      }
    } catch (err) {
      // After hijack (streaming), we own reply.raw and must not call reply.send.
      if (reply.raw.headersSent) {
        return;
      }
      if (err instanceof CapacityError) {
        reply.code(503).send({ error: "account_at_capacity" });
        return;
      }
      if (err instanceof AllUpstreamsFailed) {
        // attemptedIds is empty when no candidates existed at all.
        const errorCode =
          err.attemptedIds.length === 0
            ? "no_upstream_available"
            : "all_upstreams_failed";
        reply.code(503).send({
          error: errorCode,
          ...(err.attemptedIds.length > 0 && {
            attempted_count: err.attemptedIds.length,
          }),
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

export async function messagesRoutes(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
): Promise<void> {
  // Plan 5A PR 9g: autoRoute dispatch by group platform.
  // - anthropic-platform groups → existing 4A handler (passthrough +
  //   credential cipher resolution + Anthropic-shaped failover loop).
  // - openai-platform groups → translate Anthropic body to OpenAI
  //   Responses, call openai upstream, translate back.
  // - other platforms → 503 platform_not_yet_wired (gemini /
  //   antigravity defer to Plan 5B / 5C).
  app.post(
    "/v1/messages",
    autoRoute({
      anthropic: makeMessagesAnthropicHandler(app, opts),
      openai: makeMessagesOpenaiHandler(app, opts),
    }),
  );
}

async function runNonStreamFailover(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  signal: AbortSignal,
  /**
   * Phase 3 #2 — when present, the route handler computed a cache key
   * upfront after a cache-miss read. We store the upstream response
   * here on success so the next identical request can short-circuit.
   */
  cacheKey?: string | null,
): Promise<void> {
  // Capture start time BEFORE the failover loop so durationMs includes
  // credential resolve + slot acquire + failover switches. Sub-task B of
  // Plan 4A Part 7 — the usage-log row's `duration_ms` must reflect the
  // full user-visible latency, not just the last upstream call.
  const startedAtMs = Date.now();

  // Pull the client-facing `model` out of the already-validated body so the
  // usage-log payload's `requestedModel` matches what the caller sent.
  // (The route handler above validates `body.model` is a non-empty string
  // before invoking this function, so the cast is safe.)
  const requestedModel = (req.body as { model: string }).model;

  const result = await runFailover({
    db: app.db,
    orgId: req.apiKey!.orgId,
    teamId: req.apiKey!.teamId,
    maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
    scheduler: app.gwScheduler,
    attempt: async (account: SelectedAccount) => {
      const acquired = await acquireSlot(
        app.redis,
        "account",
        account.id,
        requestId,
        account.concurrency,
        SLOT_DURATION_MS,
      );
      if (!acquired) {
        throw new CapacityError();
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
        // TODO(part-6): wait queue admission control
        // TODO(part-6): sticky session lookup
        // TODO(part-6): idempotency cache check

        const upstream = await callUpstreamMessages({
          baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
          body: upstreamBodyBuf,
          credential,
          signal,
        });

        if (upstream.kind === "stream") {
          // Defensive guard: stream=true was gated above; upstream should not
          // return SSE for a non-streaming request.
          throw { status: 502, message: "unexpected_stream" };
        }

        if (upstream.status >= 400 && upstream.status < 500) {
          // 4xx errors are client errors — forward them directly without failover.
          // No usage log: upstream returned no usage/model payload we can trust,
          // and cost is zero anyway.
          return upstream;
        }

        if (upstream.status < 200 || upstream.status >= 300) {
          // 5xx / unexpected non-2xx → failover-eligible transient error.
          const text = upstream.body.toString("utf8");
          const ra = parseRetryAfterHeader(upstream.headers["retry-after"]);
          throw {
            status: upstream.status,
            retryAfter: ra,
            message: text.slice(0, 500),
          };
        }

        // Success (2xx). Parse the body to extract usage + model, build the
        // usage-log payload, and enqueue. We parse defensively — a
        // malformed 2xx body yields zero usage (emitUsageLog never throws).
        //
        // Position rationale: the enqueue lives INSIDE the attempt callback
        // on the success path so `account` is in scope without threading
        // state out via a closure variable. Any failure after this point
        // (reply.send errors, etc.) does not un-enqueue the job — which is
        // the correct semantic: if upstream succeeded, we should bill.
        let parsedUpstream: unknown = null;
        try {
          parsedUpstream = JSON.parse(upstream.body.toString("utf8"));
        } catch {
          // Malformed JSON — log at warn; emitUsageLog will record zero usage.
          req.log.warn(
            { requestId, accountId: account.id },
            "upstream 2xx body was not valid JSON; usage log will record zeros",
          );
        }
        await emitUsageLog({
          app,
          req,
          requestedModel,
          accountId: account.id,
          upstreamResponse: parsedUpstream,
          platform: "anthropic",
          surface: "messages",
          statusCode: upstream.status,
          durationMs: Date.now() - startedAtMs,
        });
        await emitBodyCapture({
          app,
          req,
          requestId,
          requestBodyJson: upstreamBodyBuf.toString("utf8"),
          responseBody: parsedUpstream,
          stream: false,
        });

        return upstream;
      } catch (err) {
        // Log at warn so every attempt failure (credential decrypt, upstream
        // HTTP error, connection refused, etc.) surfaces in ops output.
        // Without this the only signal is the terminal 503
        // `all_upstreams_failed` which swallows the classifier's reason.
        req.log.warn(
          {
            requestId,
            accountId: account.id,
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack }
                : err,
          },
          "gateway attempt failed",
        );
        throw err;
      } finally {
        await releaseSlot(app.redis, "account", account.id, requestId).catch(
          () => {
            // Intentionally swallowed — slot expires on its own within SLOT_DURATION_MS.
          },
        );
      }
    },
  });

  // Forward upstream status code.
  reply.code(result.status);

  // Forward relevant response headers; strip hop-by-hop headers.
  for (const [k, v] of Object.entries(result.headers)) {
    if (typeof v === "undefined") continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    reply.header(k, v as string);
  }

  // Phase 3 #2 — fire-and-forget cache write on success.  Helper
  // gates on cacheKey presence + status===200 + body size + ttl>0;
  // never throws.
  tryStoreOnSuccess(
    { redis: app.redis, ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC },
    cacheKey ?? null,
    {
      status: result.status,
      headers: result.headers,
      body: result.body,
    },
  );

  reply.send(result.body);
}

async function runStreamingFailover(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  // Take over the response — Fastify will not auto-send.
  reply.hijack();

  // Capture start time BEFORE the failover loop so durationMs / firstTokenMs /
  // bufferReleasedAtMs are all measured against the same user-visible start
  // (matches the non-streaming path — Sub-task B).
  const startedAtMs = Date.now();

  // The client-facing `model` is validated in the /v1/messages handler above
  // before this function is called, so the cast is safe.
  const requestedModel = (req.body as { model: string }).model;

  await runFailover({
    db: app.db,
    orgId: req.apiKey!.orgId,
    teamId: req.apiKey!.teamId,
    maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
    attempt: async (account: SelectedAccount) => {
      const acquired = await acquireSlot(
        app.redis,
        "account",
        account.id,
        requestId,
        account.concurrency,
        SLOT_DURATION_MS,
      );
      if (!acquired) {
        throw new CapacityError();
      }

      // Per-attempt state — reset on each failover retry so a successful
      // second account doesn't inherit the first account's (failed) counters.
      const extractor = new StreamUsageExtractor();
      let firstTokenAtMs: number | null = null;
      let bufferReleasedAtMs: number | null = null;
      // Double-emit guard: protects against the narrow race where the
      // `for await` upstream loop's `done: true` exit and a follow-up
      // iteration's `req.raw.destroyed` check could BOTH fire an
      // `emitUsageLog` call in the same microtask window, billing the
      // user twice for one request.  Set BEFORE the awaited emit so any
      // path that yields and re-enters sees the guard as tripped.
      let emitted = false;

      const buffer = new SmartBuffer({
        windowMs: opts.env.GATEWAY_BUFFER_WINDOW_MS,
        windowBytes: opts.env.GATEWAY_BUFFER_WINDOW_BYTES,
        onCommit: (chunks: Buffer[]) => {
          // Record the moment the gateway transitioned BUFFERING → COMMITTED
          // — this is the earliest point any byte was released to the client.
          if (bufferReleasedAtMs === null) {
            bufferReleasedAtMs = Date.now();
          }
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
          }
          for (const c of chunks) {
            reply.raw.write(c);
          }
        },
        onPassthrough: (chunk: Buffer) => {
          reply.raw.write(chunk);
        },
      });

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
          signal,
        });

        if (upstream.kind !== "stream") {
          // Upstream returned non-stream despite stream=true → treat as transient
          throw { status: 502, message: "expected_stream" };
        }

        if (upstream.status >= 400) {
          // Upstream returned an HTTP error status (4xx/5xx) for the stream request.
          // Consume the body to determine retry-after, then classify.
          const chunks: Buffer[] = [];
          for await (const c of upstream.body) {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          }
          const text = Buffer.concat(chunks).toString("utf8").slice(0, 500);
          const ra = parseRetryAfterHeader(upstream.headers["retry-after"]);
          throw { status: upstream.status, retryAfter: ra, message: text };
        }

        // Stream loop — relay raw upstream SSE bytes through the smart buffer.
        // Tap the extractor BEFORE SmartBuffer so usage extraction runs on the
        // raw bytes regardless of buffer state (buffering vs passthrough).
        for await (const chunk of upstream.body) {
          if (req.raw.destroyed) {
            // Client disconnected mid-stream. We still emit a usage log so the
            // partial work is visible (forensic + quota semantics: upstream
            // consumed tokens, so the user pays). Status 499 reflects the
            // client-closed-request convention and is distinct from the
            // happy-path 200 path below.
            if (emitted) return;
            emitted = true;
            await emitUsageLog({
              app,
              req,
              requestedModel,
              accountId: account.id,
              upstreamResponse: buildUpstreamShape(extractor.snapshot()),
              platform: "anthropic",
              surface: "messages",
              statusCode: 499,
              durationMs: Date.now() - startedAtMs,
              stream: true,
              firstTokenMs:
                firstTokenAtMs !== null ? firstTokenAtMs - startedAtMs : null,
              bufferReleasedAtMs:
                bufferReleasedAtMs !== null
                  ? bufferReleasedAtMs - startedAtMs
                  : null,
            });
            await emitBodyCapture({
              app,
              req,
              requestId,
              requestBodyJson: upstreamBodyBuf.toString("utf8"),
              responseBody: extractor.getAssembledTranscript(),
              stream: true,
            });
            return;
          }
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          // Extractor tap: first — records when the gateway SAW bytes from
          // upstream, independent of when SmartBuffer chooses to flush.
          if (firstTokenAtMs === null) {
            firstTokenAtMs = Date.now();
          }
          extractor.push(buf);
          await buffer.push(buf);
        }

        // Upstream finished cleanly — flush any remaining buffered chunks.
        await buffer.commit();

        if (!reply.raw.headersSent) {
          // No bytes ever flushed (empty stream) — set headers and end.
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        reply.raw.end();

        // Happy-path completion: enqueue the usage-log row.  Placed AFTER
        // reply.raw.end() so the client-visible response isn't gated on
        // usage-log emission; emitUsageLog itself never throws.  Guarded
        // by `emitted` so a same-tick race with the client-disconnect path
        // can't double-bill.
        if (emitted) return;
        emitted = true;
        await emitUsageLog({
          app,
          req,
          requestedModel,
          accountId: account.id,
          upstreamResponse: buildUpstreamShape(extractor.snapshot()),
          platform: "anthropic",
          surface: "messages",
          statusCode: 200,
          durationMs: Date.now() - startedAtMs,
          stream: true,
          firstTokenMs:
            firstTokenAtMs !== null ? firstTokenAtMs - startedAtMs : null,
          bufferReleasedAtMs:
            bufferReleasedAtMs !== null
              ? bufferReleasedAtMs - startedAtMs
              : null,
        });
        await emitBodyCapture({
          app,
          req,
          requestId,
          requestBodyJson: upstreamBodyBuf.toString("utf8"),
          responseBody: extractor.getAssembledTranscript(),
          stream: true,
        });
      } catch (err) {
        if (buffer.isFailoverEligible()) {
          // Pre-commit error: discard buffered chunks, propagate to failover
          // loop. Do NOT enqueue a usage log — the retry on another account
          // (or the post-failover exhaustion branch) will produce its own
          // log. Slot release is handled by the finally block below.
          buffer.discard();
          throw err;
        }
        // Post-commit error: write SSE error event, log, end stream, and
        // emit a usage-log row so the partial work is visible. statusCode is
        // 200 because headers already flushed as 200 — the mid-body failure
        // is what the `event: error` payload communicates.
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`,
          );
        } catch {
          // raw stream already closed — nothing we can do
        }
        try {
          reply.raw.end();
        } catch {
          // already ended
        }
        req.log.warn(
          { err: errMsg, accountId: account.id },
          "stream error after commit",
        );
        // If the happy-path or client-disconnect emit already fired (e.g.
        // the for-await loop completed cleanly and a downstream throw
        // landed us here), skip the second emit to avoid double-billing.
        if (emitted) {
          return;
        }
        emitted = true;
        await emitUsageLog({
          app,
          req,
          requestedModel,
          accountId: account.id,
          upstreamResponse: buildUpstreamShape(extractor.snapshot()),
          platform: "anthropic",
          surface: "messages",
          statusCode: 200,
          durationMs: Date.now() - startedAtMs,
          stream: true,
          firstTokenMs:
            firstTokenAtMs !== null ? firstTokenAtMs - startedAtMs : null,
          bufferReleasedAtMs:
            bufferReleasedAtMs !== null
              ? bufferReleasedAtMs - startedAtMs
              : null,
        });
        await emitBodyCapture({
          app,
          req,
          requestId,
          requestBodyJson: upstreamBodyBuf.toString("utf8"),
          responseBody: extractor.getAssembledTranscript(),
          stream: true,
          attemptErrors: errMsg,
        });
      } finally {
        await releaseSlot(app.redis, "account", account.id, requestId).catch(
          () => {},
        );
      }
    },
  }).catch((err) => {
    // After hijack, AllUpstreamsFailed / FatalUpstreamError can't go through reply.send.
    // Emit error event if headers not sent yet, otherwise log only.
    if (!reply.raw.headersSent) {
      if (err instanceof CapacityError) {
        reply.raw.writeHead(503, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "account_at_capacity" }));
        return;
      }
      const status = err instanceof FatalUpstreamError ? err.statusCode : 503;
      const reason =
        err instanceof FatalUpstreamError
          ? err.reason
          : err instanceof AllUpstreamsFailed && err.attemptedIds.length === 0
            ? "no_upstream_available"
            : "all_upstreams_failed";
      reply.raw.writeHead(status, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: reason, request_id: requestId }));
    } else {
      try {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({
            error: "stream_failed",
            request_id: requestId,
          })}\n\n`,
        );
        reply.raw.end();
      } catch {
        // already closed
      }
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "stream failover exhausted post-headers",
      );
    }
  });
}

/**
 * Wrap a streaming-usage snapshot into the object shape the shared
 * `buildUsageLogPayload` → `extractUsageFromAnthropicResponse` helper
 * expects. Keeping this local (and NOT extending `usageLogging.ts` to accept
 * both shapes) avoids growing the shared helper's surface with a
 * streaming-specific branch that only the `/v1/messages` stream route needs.
 */
function buildUpstreamShape(
  snap: StreamUsageSnapshot,
): Record<string, unknown> {
  return {
    model: snap.model,
    usage: {
      input_tokens: snap.input_tokens,
      output_tokens: snap.output_tokens,
      cache_creation_input_tokens: snap.cache_creation_tokens,
      cache_read_input_tokens: snap.cache_read_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Plan 5A PR 9g — openai-platform branch for /v1/messages.
//
// Cross-format flow when an Anthropic-format client request hits an
// openai-platform group:
//
//   1. Validate body is Anthropic-shaped (existing checks above).
//   2. translateAnthropicToResponses(body) → OpenAI Responses request.
//   3. runFailover + scheduler + slot — same as the openai branch in
//      /v1/responses (PR 9d).
//   4. callUpstreamResponses with the translated body.
//   5. translateResponsesResponseToAnthropic on the upstream response.
//   6. Return Anthropic-shaped JSON to the client.
//
// Streaming defers to PR 9h (needs the Responses-stream-to-Anthropic
// translator from PR #41 + the SSE pipe wiring).
// ---------------------------------------------------------------------------

export function makeMessagesOpenaiHandler(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
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

    // Body validation is best-effort — the 4A inline handler also
    // forwards loose-shaped Anthropic bodies upstream. The translator
    // is total over a well-shaped input but may throw when invoked on
    // malformed `tools[].input_schema` or unexpected `tool_use` block
    // shapes; we catch that throw below and surface 400.  Proper Zod
    // validation could move here once an `AnthropicMessagesRequestSchema`
    // exists in gateway-core (deferred).
    const anthropicBody = body as unknown as AnthropicMessagesRequest;
    const isStream = body.stream === true;

    // Phase 3 #2 — share cache scope `v1/messages` with the
    // anthropic-platform handler. Both handlers see the same
    // anthropic-shape client body and emit anthropic-shape responses,
    // so a hit cached by either branch replays correctly through the
    // other after a group reconfigure.
    const clientBodyBuf = Buffer.from(JSON.stringify(body));
    let cacheKey: string | null = null;
    if (!isStream) {
      const result = await checkRouteCache({
        redis: app.redis,
        ttlSec: opts.env.GATEWAY_CACHE_TTL_SEC,
        orgId: req.gwOrg.id,
        scope: "v1/messages",
        bodyBuf: clientBodyBuf,
        reply,
        onResult: (r) => app.gwMetrics.gwCacheTotal.inc({ result: r }),
      });
      if (result.hit) return;
      cacheKey = result.cacheKey;
    }

    let openaiBody;
    try {
      openaiBody = translateAnthropicToResponses(anthropicBody);
    } catch (err) {
      reply.code(400).send({
        error: "invalid_request",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const requestId = req.id;
    // For the streaming path we need stream=true on the upstream body
    // so callUpstreamResponses asks for text/event-stream.
    const upstreamBody = isStream
      ? { ...openaiBody, stream: true }
      : openaiBody;
    const upstreamBodyBuf = Buffer.from(JSON.stringify(upstreamBody));
    const startedAtMs = Date.now();
    const requestedModel = anthropicBody.model;

    if (isStream) {
      await runMessagesOpenaiStreamingFailover(
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

    // Wire AbortSignal from client disconnect → upstream cancel.
    // Without this, a long-running OpenAI call keeps holding upstream
    // resources for up to 60s after the client gives up.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.once("close", onClose);

    try {
      const anthropicResp = await runFailover({
        db: app.db,
        orgId: req.apiKey.orgId,
        teamId: req.apiKey.teamId,
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
                ? translateResponsesResponseToAnthropic(
                    openaiResp as Parameters<
                      typeof translateResponsesResponseToAnthropic
                    >[0],
                  )
                : null;

              // Forensic-row contract: emitUsageLog runs BEFORE the
              // parse-failure throw so a malformed-2xx attempt leaves
              // a zero-cost row recording which account misbehaved.
              // With N accounts all returning malformed 2xx we'd
              // write N rows + 1 final 503 — intentional, lets ops
              // count "how many of my accounts are returning bad
              // data" via dashboards. Mirrors PR 9b/9d/9e.
              await emitUsageLog({
                app,
                req,
                requestedModel,
                accountId: account.id,
                upstreamResponse: translated,
                // `platform` is the inbound URL space (anthropic for
                // /v1/messages), NOT the upstream provider. The
                // upstream OpenAI account can be pivoted via
                // `accountId` joined to `account.platform`.
                platform: usageLogInboundPlatformForSurface("messages"),
                surface: "messages",
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

      // Serialize once so the cache stores the exact bytes Fastify
      // emits (no risk of cached version drifting due to key-order
      // differences in JSON.stringify on the replay path).
      const responseBuf = Buffer.from(JSON.stringify(anthropicResp));
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

// ---------------------------------------------------------------------------
// Plan 5A PR 9h — openai-stream branch for /v1/messages.
//
// Shape mirrors `runOpenaiResponsesStreamingPassthrough` (responses.ts)
// but with the inverse translator wired in:
//
//   * `parseOpenAIResponsesSse(upstream.body)` → typed
//     `ResponsesSSEEvent` async iterator (PR #46).
//   * `makeResponsesToAnthropicStream()` (PR #41) maps each upstream
//     event to a list of `AnthropicSSEEvent` outputs.
//   * Each Anthropic event is serialized to SSE bytes
//     `event: <type>\ndata: <json>\n\n` and written to `reply.raw`.
//   * The terminal `response.completed` event's usage is captured
//     into a `usageRef` box so the pricing path runs unchanged after
//     the stream closes (synthetic Anthropic shape via
//     `buildSyntheticAnthropicUsage`).
//   * On mid-stream error / failover collapse, an Anthropic-shaped
//     `event: error` with `{ type: "error", error: { type, message } }`
//     is emitted (Anthropic SDK consumers parse this shape — distinct
//     from the OpenAI Responses error shape used in responses.ts).
//
// `platform` on the usage_log row is `"anthropic"` (the inbound URL
// space) per `usageLogInboundPlatformForSurface("messages")` — the
// upstream OpenAI provider is recoverable from the `accountId` join.
// ---------------------------------------------------------------------------

async function runMessagesOpenaiStreamingFailover(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  requestedModel: string,
  startedAtMs: number,
): Promise<void> {
  reply.hijack();

  // AbortSignal from client disconnect → upstream cancel. Without
  // this a slow upstream keeps holding resources for up to 60s after
  // the client gives up.
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
            // for the pricing path.  Box via usageRef to dodge TS
            // closure-narrowing on assignments inside flushEvent.
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

            const translator = makeResponsesToAnthropicStream();

            const flushAnthropicEvent = (ev: AnthropicSSEEvent): void => {
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
                if (
                  event.type === "response.completed" &&
                  event.response.usage
                ) {
                  usageRef.current = event.response.usage;
                }
                for (const out of translator.onEvent(event)) {
                  flushAnthropicEvent(out);
                }
              }
              for (const out of translator.onEnd()) {
                flushAnthropicEvent(out);
              }
            } catch (err) {
              // Mid-stream error → emit Anthropic-shaped error event
              // and close cleanly.  SDK clients parse this shape.
              reply.raw.write(
                serializeAnthropicSseError(
                  err instanceof Error ? err.name : "unknown",
                  err instanceof Error ? err.message : String(err),
                  requestId,
                ),
              );
            }

            reply.raw.end();

            // Pricing path: synthesize an Anthropic-shaped response
            // from the captured Responses usage so the existing
            // pricing column in usage_log is populated unchanged.
            const completedUsage = usageRef.current;
            const cachedTokens =
              completedUsage?.input_tokens_details?.cached_tokens ?? 0;
            const upstreamForLog = completedUsage
              ? buildSyntheticAnthropicUsage({
                  id: `synthetic:openai-stream-messages:${requestId}`,
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
              platform: usageLogInboundPlatformForSurface("messages"),
              surface: "messages",
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
      serializeAnthropicSseError,
    );
  } finally {
    req.raw.removeListener("close", onClose);
  }
}
