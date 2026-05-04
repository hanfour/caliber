// Plan 5A PR 9f — Codex CLI alias route.
//
// `/backend-api/codex/responses` (+ subpath variant) is the URL the
// OpenAI Codex CLI hits natively. Per design A20, this URL ALWAYS
// routes to the OpenAI Responses handler regardless of group
// platform — wrapped in `forcePlatform("openai")` so a Codex CLI
// request hitting an anthropic-platform key sees a clear 403 error
// instead of being silently translated through the Anthropic path
// (which would either confuse the upstream or break tool semantics).
//
// The handler body is shared with `/v1/responses` via
// `makeResponsesRouteHandler` from `routes/responses.ts`. When
// `forcePlatform` clears, the inner handler dispatches by
// `ctx.platform` — which is openai, so it goes down the openai
// branch (passthrough body to OpenAI Responses upstream).
//
// The subpath variant catches Codex CLI clients that append paths
// like `/backend-api/codex/responses/v1` — sub2api had several
// recorded versions doing this, and we follow the same pattern. The
// path tail is ignored by the handler (it only reads the body).

import type { FastifyInstance } from "fastify";
import { forcePlatform } from "./dispatch.js";
import {
  makeResponsesRouteHandler,
  type ResponsesRouteOptions,
} from "./responses.js";

// Same shape as the parent route's options — alias rather than redefine
// so the contract stays in one place.
export type CodexResponsesRouteOptions = ResponsesRouteOptions;

export async function codexResponsesRoutes(
  app: FastifyInstance,
  opts: CodexResponsesRouteOptions,
): Promise<void> {
  const baseHandler = makeResponsesRouteHandler(app, opts);
  // `forcePlatform` returns 401 when there's no group context, 403
  // when ctx.platform doesn't match. The inner handler is only
  // reached for openai-platform groups; we still call it through
  // `makeResponsesRouteHandler` so any future shared logic
  // (validation, logging) stays in one place.
  const guardedHandler = forcePlatform("openai", baseHandler);

  app.post("/backend-api/codex/responses", guardedHandler);
  // sub2api ports observed Codex CLI versions appending arbitrary
  // subpaths (`/v1`, `/v1/openai`, etc.). Fastify's find-my-way
  // requires `*` to be the last character — using bare `*` matches
  // any tail.  We log the actual tail at debug so operators can
  // metric Codex CLI version drift; the handler itself ignores the
  // path tail and only reads the body.
  app.post("/backend-api/codex/responses/*", async (req, reply) => {
    app.log.debug(
      { codexSubpath: req.url, requestId: req.id },
      "codex CLI subpath hit",
    );
    await guardedHandler(req, reply);
  });
}
