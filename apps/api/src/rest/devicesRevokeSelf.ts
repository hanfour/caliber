// apps/api/src/rest/devicesRevokeSelf.ts
//
// DELETE /v1/devices/me — daemon-facing self-revoke.
// Authenticated by Bearer cda_* via resolveDeviceFromAuthAllowRevoked (NOT the
// standard resolveDeviceFromAuth — see ingestAuth.ts for the alreadyRevoked
// short-circuit rationale).
//
// Response contract (Spec §5):
//   204  → first revoke for this device, audit log written
//   410  → device already revoked (idempotent re-call OR concurrent loser)
//   401  → missing_token | invalid_token | key_revoked | device_inactive
//   404  → not_found (ENABLE_GATEWAY=false)
//   500  → internal (server_misconfigured or unexpected DB failure)
//
// Note: device_revoked is intentionally NOT a 401 case here — repeated DELETEs
// from the same revoked device get a clean 410 instead.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { devices } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuthAllowRevoked } from "./ingestAuth.js";
import { writeAudit } from "../services/audit.js";
import { AUDIT_ACTIONS } from "../services/auditActions.js";

export function devicesRevokeSelfRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.delete("/v1/devices/me", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }

      const auth = await resolveDeviceFromAuthAllowRevoked(
        fastify.db,
        env,
        req.headers.authorization,
      );
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          // Surface the underlying config gap to ops via the request log,
          // without leaking the env-var name (or anything else) to the
          // client — which only sees the generic 500 "internal".
          fastify.log.error(
            { missing_env: "API_KEY_HASH_PEPPER" },
            "DELETE /v1/devices/me: server_misconfigured (cannot resolve cda_* token)",
          );
          reply.code(500);
          return { error: "internal" };
        }
        reply.code(401);
        return { error: auth.error };
      }
      if (auth.device.alreadyRevoked) {
        reply.code(410);
        return { error: "device_already_revoked" };
      }

      try {
        // Soft-revoke + audit inside one transaction. The WHERE clause filters
        // on revoked_at IS NULL so concurrent DELETEs serialise via Postgres
        // MVCC: first writer wins (rowCount=1), losers see rowCount=0 and we
        // map them to 410 — same shape as the idempotent re-call path.
        const result = await fastify.db.transaction(async (tx) => {
          const updated = await tx
            .update(devices)
            .set({ status: "revoked", revokedAt: sql`NOW()` })
            .where(
              and(
                eq(devices.id, auth.device.deviceId),
                isNull(devices.revokedAt),
              ),
            )
            .returning({ id: devices.id });

          if (updated.length === 0) {
            return { state: "already-revoked" as const };
          }

          await writeAudit(tx, {
            actorUserId: auth.device.userId,
            action: AUDIT_ACTIONS.DEVICE_SELF_REVOKED,
            targetType: "device",
            targetId: auth.device.deviceId,
            orgId: auth.device.orgId,
            metadata: {
              trigger: "agent_uninstall",
              user_agent: req.headers["user-agent"] ?? null,
            },
          });
          return { state: "revoked" as const };
        });

        if (result.state === "already-revoked") {
          reply.code(410);
          return { error: "device_already_revoked" };
        }
        reply.code(204);
        return null;
      } catch (err) {
        fastify.log.error({ err }, "devices.revoke_self unexpected error");
        reply.code(500);
        return { error: "internal" };
      }
    });
  };
}
