// API-key migration plan Phase 3 #4-b — per-apiKey rate limit. Sits
// after `apiKeyAuthPlugin` so it can read `req.apiKey.id`, and before
// any route that does upstream-billable work. Public paths (/health,
// /metrics, /oauth/callback) are skipped — the auth plugin set
// req.apiKey to null for them, and we treat that as "not subject to
// per-apiKey rate limit".

import fp from "fastify-plugin";
import type { ServerEnv } from "@caliber/config";
import { checkApiKeyRateLimit } from "../redis/rateLimit.js";

export interface RateLimitOptions {
  env: ServerEnv;
}

export const rateLimitPlugin = fp<RateLimitOptions>(pluginBody, {
  name: "rateLimitPlugin",
  // We need both `fastify.redis` (decorated by redisPlugin) and
  // `req.apiKey` (set by apiKeyAuthPlugin's preHandler).
  dependencies: ["apiKeyAuthPlugin"],
});

async function pluginBody(
  fastify: import("fastify").FastifyInstance,
  opts: RateLimitOptions,
): Promise<void> {
  const limit = opts.env.GATEWAY_APIKEY_RPM_LIMIT;

  fastify.addHook("preHandler", async (req, reply) => {
    // 0 disables enforcement entirely (env knob).
    if (limit === 0) return;
    // Public paths set req.apiKey to null — nothing to gate on.
    if (!req.apiKey) return;

    let result;
    try {
      result = await checkApiKeyRateLimit(fastify.redis, req.apiKey.id, limit);
    } catch (err) {
      // Fail open on Redis errors — losing rate limiting is preferable
      // to losing all traffic. Still log + count so operators notice
      // and can alert on `gw_rate_limit_fail_open_total`.
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "rate_limit_check_failed",
      );
      // Decorate may not be set in unit tests that build a bare fastify
      // — guard so the plugin stays test-friendly.
      fastify.gwMetrics?.gwRateLimitFailOpenTotal.inc();
      fastify.gwMetrics?.redisErrorTotal.inc({ op: "rate_limit" });
      return;
    }

    if (result.exceeded) {
      reply
        .code(429)
        .header("retry-after", String(result.retryAfterSec))
        .header("x-ratelimit-limit", String(limit))
        .header("x-ratelimit-remaining", "0")
        .header("x-ratelimit-reset", String(result.retryAfterSec))
        .send({
          error: "rate_limited",
          limit,
          window: "60s",
          retryAfterSec: result.retryAfterSec,
        });
      return reply;
    }

    // Surface remaining headroom so clients can self-throttle.
    reply.header("x-ratelimit-limit", String(limit));
    reply.header(
      "x-ratelimit-remaining",
      String(Math.max(0, limit - result.count)),
    );
  });
}
