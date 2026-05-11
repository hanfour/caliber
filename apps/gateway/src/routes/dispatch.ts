// Dispatch helpers for group-aware route registration (Plan 5A Part 8,
// Tasks 8.3 + 8.4).
//
// `autoRoute` picks a per-platform handler based on the resolved
// `req.gwGroupContext.platform`. Used at routes that span platforms,
// e.g. `/v1/messages` (Anthropic format input → Anthropic OR OpenAI
// upstream depending on the api key's group). When the group context
// hasn't been set (route registered before groupContextPlugin, or
// public path), we still need a sensible default — fall back to
// `anthropic` to preserve 4A behaviour.
//
// `forcePlatform` is the sub2api `ForcePlatform` analogue but inverted:
// instead of overwriting the group's platform on the request (which
// would let a Codex CLI alias hit an Anthropic group), we **reject**
// requests whose group platform doesn't match. Safer — the api key
// holder picked their group on purpose.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Platform } from "@caliber/gateway-core";

export type DispatchHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

const DEFAULT_FALLBACK_PLATFORM: Platform = "anthropic";

/**
 * Routes the request to the handler keyed by the group's platform.
 * Falls back to `fallback` (or 4A's anthropic default) when the
 * platform-specific handler is missing.
 */
export function autoRoute(
  byPlatform: Partial<Record<Platform, DispatchHandler>>,
  fallback?: DispatchHandler,
): DispatchHandler {
  return async (req, reply) => {
    const platform =
      req.gwGroupContext?.platform ?? DEFAULT_FALLBACK_PLATFORM;
    const handler = byPlatform[platform] ?? fallback;
    if (!handler) {
      reply.code(404).send({
        error: "platform_not_supported_by_route",
        platform,
      });
      return;
    }
    return await handler(req, reply);
  };
}

/**
 * Wraps a handler with a guard that requires `req.gwGroupContext.platform`
 * to match `expected`. Used by alias routes (e.g. Codex CLI's native
 * `/v1/responses` URL) so they can't be invoked under a non-OpenAI
 * group key. Returns 401 when no group context is present, 403 on
 * mismatch.
 */
export function forcePlatform(
  expected: Platform,
  handler: DispatchHandler,
): DispatchHandler {
  return async (req, reply) => {
    const ctx = req.gwGroupContext;
    if (!ctx) {
      reply.code(401).send({ error: "group_required" });
      return;
    }
    if (ctx.platform !== expected) {
      reply.code(403).send({
        error: "route_platform_mismatch",
        expected,
        actual: ctx.platform,
      });
      return;
    }
    return await handler(req, reply);
  };
}
