import type { FastifyRequest } from "fastify";
import type { Platform } from "../oauth/types.js";

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
    throw new Error(`platformForGatewayRoute: no platform mapping for route ${url ?? "<unknown>"}`);
  }
  return platform;
}
