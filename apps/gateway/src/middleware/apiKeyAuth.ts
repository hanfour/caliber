import fp from "fastify-plugin";
import { and, eq, isNull } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { hashApiKey } from "@caliber/gateway-core";
import { apiKeys, users, organizations } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveClientIp } from "./resolveClientIp.js";
import {
  checkIpBlocked,
  recordAuthFailure,
  type AuthThrottleConfig,
} from "../redis/ipAuthThrottle.js";

declare module "fastify" {
  interface FastifyRequest {
    apiKey: {
      id: string;
      orgId: string;
      userId: string;
      teamId: string | null;
      // Plan 5A migration 0008. NULL = legacy 4A api key (no group binding);
      // groupContext middleware synthesises a virtual group in that case.
      groupId: string | null;
      quotaUsd: string;
      quotaUsedUsd: string;
      routingPolicy: "pool" | "own" | "own_then_pool";
    } | null;
    gwUser: { id: string; email: string } | null;
    gwOrg: {
      id: string;
      slug: string;
      contentCaptureEnabled: boolean;
      retentionDaysOverride: number | null;
    } | null;
  }
  interface FastifyInstance {
    db: Database;
  }
}

export interface ApiKeyAuthOptions {
  env: ServerEnv;
}

// /metrics is intentionally NOT public on the gateway's public listener.
// It moved to a private listener (apps/gateway/src/plugins/metricsServer.ts)
// bound to METRICS_HOST:METRICS_PORT. Unauthenticated requests to
// `/metrics` on the public port now hit apiKeyAuth and return 401, which
// is the desired behavior per audit 2026-05-20 finding #5.
const PUBLIC_PATHS = new Set(["/health"]);

export const apiKeyAuthPlugin = fp<ApiKeyAuthOptions>(pluginBody, {
  name: "apiKeyAuthPlugin",
  dependencies: ["dbPlugin"],
});

async function pluginBody(
  fastify: import("fastify").FastifyInstance,
  opts: ApiKeyAuthOptions,
): Promise<void> {
  fastify.decorateRequest("apiKey", null);
  fastify.decorateRequest("gwUser", null);
  fastify.decorateRequest("gwOrg", null);

  const throttleCfg: AuthThrottleConfig = {
    max: opts.env.GATEWAY_AUTH_FAIL_MAX ?? 10,
    windowSec: opts.env.GATEWAY_AUTH_FAIL_WINDOW_SEC ?? 300,
    blockSec: opts.env.GATEWAY_AUTH_FAIL_BLOCK_SEC ?? 900,
  };
  const trustedProxies = (opts.env.GATEWAY_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Centralised auth-failure handler: runs the per-IP brute-force throttle
  // (Redis), returns 429 when blocked/just-blocked, else the original error.
  // Fail-open on Redis errors (availability > brute-force defence).
  async function failAuth(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    ip: string,
    status: number,
    errCode: string,
  ): Promise<import("fastify").FastifyReply> {
    if (throttleCfg.max <= 0) {
      // throttle disabled → no Redis work, original error verbatim
      return reply.code(status).send({ error: errCode });
    }
    // fastify.redis is typed non-null (redisPlugin decorates it), but test
    // harnesses build a bare fastify without registering redisPlugin. Widen to
    // include undefined and treat a missing client as fail-open (original error).
    const redisClient: import("ioredis").Redis | undefined = fastify.redis;
    if (!redisClient) {
      return reply.code(status).send({ error: errCode });
    }
    try {
      const blocked = await checkIpBlocked(redisClient, ip);
      if (blocked.blocked) {
        fastify.gwMetrics?.gwAuthFailThrottleTotal.inc();
        return reply
          .code(429)
          .header("retry-after", String(blocked.retryAfterSec))
          .send({ error: "rate_limited" });
      }
      const rec = await recordAuthFailure(redisClient, ip, throttleCfg);
      if (rec.justBlocked) {
        fastify.gwMetrics?.gwAuthFailThrottleTotal.inc();
        return reply
          .code(429)
          .header("retry-after", String(rec.retryAfterSec))
          .send({ error: "rate_limited" });
      }
    } catch (err) {
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auth_throttle_check_failed",
      );
      fastify.gwMetrics?.redisErrorTotal.inc({ op: "auth_throttle" });
      // fail-open → fall through to the original error below
    }
    return reply.code(status).send({ error: errCode });
  }

  fastify.addHook("preHandler", async (req, reply) => {
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;

    const ip = resolveClientIp(req, trustedProxies);

    const raw = extractKey(req.headers);
    if (!raw) {
      return failAuth(req, reply, ip, 401, "missing_api_key");
    }

    const pepper = opts.env.API_KEY_HASH_PEPPER;
    if (!pepper) {
      reply.code(500).send({ error: "server_misconfigured" });
      return reply;
    }
    const keyHash = hashApiKey(pepper, raw);

    const row = await fastify.db
      .select({
        apiKey: apiKeys,
        user: { id: users.id, email: users.email },
        org: {
          id: organizations.id,
          slug: organizations.slug,
          contentCaptureEnabled: organizations.contentCaptureEnabled,
          retentionDaysOverride: organizations.retentionDaysOverride,
        },
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(organizations.deletedAt)))
      .limit(1)
      .then((r) => r[0]);

    if (!row) {
      return failAuth(req, reply, ip, 401, "key_invalid");
    }

    if (row.apiKey.revokedAt !== null) {
      return failAuth(req, reply, ip, 401, "key_revoked");
    }

    if (row.apiKey.expiresAt !== null && row.apiKey.expiresAt <= new Date()) {
      return failAuth(req, reply, ip, 401, "key_expired");
    }

    if (row.apiKey.revealTokenHash !== null && row.apiKey.revealedAt === null) {
      return failAuth(req, reply, ip, 401, "key_not_yet_revealed");
    }

    const blacklist = row.apiKey.ipBlacklist ?? [];
    const whitelist = row.apiKey.ipWhitelist ?? [];

    if (blacklist.length > 0 && matchesAny(ip, blacklist)) {
      return failAuth(req, reply, ip, 403, "ip_not_allowed");
    }

    if (whitelist.length > 0 && !matchesAny(ip, whitelist)) {
      return failAuth(req, reply, ip, 403, "ip_not_allowed");
    }

    req.apiKey = {
      id: row.apiKey.id,
      orgId: row.apiKey.orgId,
      userId: row.apiKey.userId,
      teamId: row.apiKey.teamId,
      groupId: row.apiKey.groupId,
      quotaUsd: row.apiKey.quotaUsd,
      quotaUsedUsd: row.apiKey.quotaUsedUsd,
      routingPolicy: row.apiKey.routingPolicy as "pool" | "own" | "own_then_pool",
    };
    req.gwUser = row.user;
    req.gwOrg = {
      id: row.org.id,
      slug: row.org.slug,
      contentCaptureEnabled: row.org.contentCaptureEnabled,
      retentionDaysOverride: row.org.retentionDaysOverride ?? null,
    };
  });
}

function extractKey(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string" && xKey.trim().length > 0) {
    return xKey.trim();
  }
  return null;
}

function matchesAny(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  try {
    const parsed = ipaddr.process(ip);
    return cidrs.some((c) => {
      try {
        const cidr = c.includes("/")
          ? c
          : `${c}/${parsed.kind() === "ipv6" ? 128 : 32}`;
        return parsed.match(ipaddr.parseCIDR(cidr));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
