// apps/api/src/rest/agentConfig.ts
// GET /v1/agent-config: the resident telemetry agent polls this hourly to
// learn how often it should poll (org-admin configurable via tRPC
// devices.agentConfig.set). Auth mirrors GET /v1/redaction-set — Bearer
// cda_* device key resolved through the shared ingestAuth helper.
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { organizations } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuth } from "./ingestAuth.js";

export const AGENT_POLL_MIN_SEC = 30;
export const AGENT_POLL_MAX_SEC = 1800;
export const AGENT_POLL_DEFAULT_SEC = 60;
export const AGENT_CONFIG_TTL_SEC = 3600;

export function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return AGENT_POLL_DEFAULT_SEC;
  return Math.min(AGENT_POLL_MAX_SEC, Math.max(AGENT_POLL_MIN_SEC, Math.round(n)));
}

export function agentConfigRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/v1/agent-config", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const auth = await resolveDeviceFromAuth(fastify.db, env, req.headers.authorization);
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          reply.code(500);
          return { error: "server_misconfigured" };
        }
        reply.code(401);
        return { error: auth.error };
      }
      const [row] = await fastify.db
        .select({ interval: organizations.agentPollIntervalSeconds })
        .from(organizations)
        .where(eq(organizations.id, auth.device.orgId))
        .limit(1);
      const interval = row?.interval == null ? AGENT_POLL_DEFAULT_SEC : clampInterval(row.interval);
      reply.code(200);
      return { poll_interval_seconds: interval, ttl_seconds: AGENT_CONFIG_TTL_SEC };
    });
  };
}
