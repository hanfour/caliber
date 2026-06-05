import type { FastifyRequest } from "fastify";
import type { Platform } from "../oauth/types.js";

const ROUTE_PLATFORM: Record<string, Platform> = {
  "/v1/messages": "anthropic",
  "/v1/chat/completions": "openai",
  "/v1/responses": "openai",
  "/v1/responses/compact": "openai",
  "/backend-api/codex/responses": "openai",
};

/** Single source of truth for a non-pool request's platform. MUST be updated
 *  whenever a gateway upstream route is added. */
export function platformForGatewayRoute(req: FastifyRequest): Platform {
  const url = req.routeOptions?.url;
  const platform = url ? ROUTE_PLATFORM[url] : undefined;
  if (!platform) {
    throw new Error(`platformForGatewayRoute: no platform mapping for route ${url ?? "<unknown>"}`);
  }
  return platform;
}
