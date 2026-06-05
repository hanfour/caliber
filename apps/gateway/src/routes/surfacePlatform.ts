import type { FastifyRequest } from "fastify";
import type { Platform } from "../oauth/types.js";

/**
 * Thrown by `platformForGatewayRoute` when a non-pool (BYOK) key hits a route
 * that is not in ROUTE_PLATFORM. Carries `statusCode: 400` (Fastify convention)
 * so the gateway's `setErrorHandler` safety net honours it as a clean 400
 * `unsupported_route` instead of letting it default to a Fastify 500. Before the
 * safety net existed this throw escaped uncaught and 500'd.
 */
export class UnsupportedRouteError extends Error {
  /** Fastify reads `statusCode` off thrown errors; the safety net honours it. */
  public readonly statusCode = 400;
  /** Stable machine-readable code the safety net puts in the JSON body. */
  public readonly errorCode = "unsupported_route";
  constructor(url: string | undefined) {
    super(
      `platformForGatewayRoute: no platform mapping for route ${url ?? "<unknown>"}`,
    );
    this.name = "UnsupportedRouteError";
  }
}

// Keys MUST be the *registered* Fastify route patterns (i.e. the verbatim
// string passed to `app.post(...)`), because `req.routeOptions.url` is the
// matched-route pattern, NOT the request path. In particular the Codex route
// is registered both bare and as a `find-my-way` wildcard, so a CLI subpath
// hit (e.g. `/backend-api/codex/responses/v1`) matches the `/*` pattern and
// `routeOptions.url` is `/backend-api/codex/responses/*` — both keys are
// required or a BYOK key on a Codex subpath would throw below (→ 500).
const ROUTE_PLATFORM: Record<string, Platform> = {
  "/v1/messages": "anthropic",
  "/v1/chat/completions": "openai",
  "/v1/responses": "openai",
  "/v1/responses/compact": "openai",
  "/backend-api/codex/responses": "openai",
  "/backend-api/codex/responses/*": "openai",
};

/** Single source of truth for a non-pool request's platform. MUST be updated
 *  whenever a gateway upstream route is added. Keys are registered route
 *  patterns (`req.routeOptions.url`), not request paths. */
export function platformForGatewayRoute(req: FastifyRequest): Platform {
  const url = req.routeOptions?.url;
  const platform = url ? ROUTE_PLATFORM[url] : undefined;
  if (!platform) {
    // Typed 400-carrying error: the setErrorHandler safety net maps it to a
    // clean `unsupported_route` 400 (a bare `throw new Error(...)` would default
    // to a Fastify 500 with no controlled body).
    throw new UnsupportedRouteError(url);
  }
  return platform;
}
