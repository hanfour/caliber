import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { devices, deviceEnrollmentTokens, deviceApiKeys } from "@caliber/db";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import type { ServerEnv } from "@caliber/config";
import { hashEnrollmentToken } from "../trpc/routers/devices.js";
import { writeAudit } from "../services/audit.js";

// POST /v1/devices/enroll — daemon-facing, NOT session-authenticated.
// Authentication is by the one-shot enrollment token presented in the JSON
// body; on success we return the bare `cda_*` device key exactly once (the DB
// stores only its HMAC). Idempotency: the enrollment token is single-use; a
// second call with the same token returns 410 GONE.

const enrollBodySchema = z.object({
  token: z.string().min(20).max(200),
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(255),
  agentVersion: z.string().min(1).max(64),
});

export function devicesEnrollRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post("/v1/devices/enroll", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const pepper = env.API_KEY_HASH_PEPPER;
      if (!pepper) {
        reply.code(500);
        return { error: "server_misconfigured" };
      }

      const parsed = enrollBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        // Bare error code only — this runs BEFORE the token check, so the
        // response is unauthenticated; do not echo zod's field-path shape
        // (matches deviceAuth.ts).
        return { error: "invalid_body" };
      }
      const { token, hostname, os, agentVersion } = parsed.data;

      const tokenHash = hashEnrollmentToken(pepper, token);

      // Atomically: look up the token, validate state, issue device + key,
      // mark token used. Wrap in a transaction so a partial failure leaves
      // no orphan device or partially-consumed token.
      try {
        const result = await fastify.db.transaction(async (tx) => {
          const [tokenRow] = await tx
            .select({
              id: deviceEnrollmentTokens.id,
              userId: deviceEnrollmentTokens.userId,
              orgId: deviceEnrollmentTokens.orgId,
              expiresAt: deviceEnrollmentTokens.expiresAt,
              usedAt: deviceEnrollmentTokens.usedAt,
            })
            .from(deviceEnrollmentTokens)
            .where(eq(deviceEnrollmentTokens.tokenHash, tokenHash))
            .limit(1)
            .for('update');

          if (!tokenRow) {
            throw { code: "INVALID_TOKEN" as const };
          }
          if (tokenRow.usedAt !== null) {
            throw { code: "TOKEN_USED" as const };
          }
          if (tokenRow.expiresAt.getTime() <= Date.now()) {
            throw { code: "TOKEN_EXPIRED" as const };
          }

          const [deviceRow] = await tx
            .insert(devices)
            .values({
              userId: tokenRow.userId,
              orgId: tokenRow.orgId,
              hostname,
              os,
              agentVersion,
            })
            .returning({ id: devices.id });
          if (!deviceRow) {
            throw { code: "DB_INSERT_FAILED" as const };
          }

          const { raw, prefix } = generateDeviceKey();
          const keyHash = hashDeviceKey(pepper, raw);
          await tx.insert(deviceApiKeys).values({
            deviceId: deviceRow.id,
            keyHash,
            keyPrefix: prefix,
          });

          const updateResult = await tx
            .update(deviceEnrollmentTokens)
            .set({
              usedAt: sql`NOW()`,
              usedByDeviceId: deviceRow.id,
            })
            .where(
              and(
                eq(deviceEnrollmentTokens.id, tokenRow.id),
                isNull(deviceEnrollmentTokens.usedAt),
              ),
            );
          if ((updateResult.rowCount ?? 0) !== 1) {
            // Defence-in-depth: the FOR UPDATE lock serialises concurrent
            // redemptions, so this guard should be rare in normal operation.
            // It can still fire if usedAt was set outside this transaction
            // (admin write, bulk expiry, token-cancellation path, etc.).
            // Return TOKEN_USED so the caller gets a clean 410 rather than a 500.
            throw { code: "TOKEN_USED" as const };
          }

          await writeAudit(tx, {
            actorUserId: tokenRow.userId,
            action: "device.enrolled",
            targetType: "device",
            targetId: deviceRow.id,
            orgId: tokenRow.orgId,
            metadata: {
              hostname,
              os,
              agentVersion,
              keyPrefix: prefix,
              enrollmentTokenId: tokenRow.id,
            },
          });

          return {
            deviceId: deviceRow.id,
            key: raw,
            keyPrefix: prefix,
          };
        });

        reply.code(201);
        return result;
      } catch (err) {
        if (err && typeof err === "object" && "code" in err) {
          const code = (err as { code: string }).code;
          if (code === "INVALID_TOKEN") {
            reply.code(401);
            return { error: "invalid_token" };
          }
          if (code === "TOKEN_USED") {
            reply.code(410);
            return { error: "token_already_used" };
          }
          if (code === "TOKEN_EXPIRED") {
            reply.code(410);
            return { error: "token_expired" };
          }
          if (code === "DB_INSERT_FAILED") {
            reply.code(500);
            return { error: "db_insert_failed" };
          }
        }
        fastify.log.error({ err }, "devices.enroll unexpected error");
        reply.code(500);
        return { error: "internal_error" };
      }
    });
  };
}
