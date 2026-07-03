import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { ServerEnv } from "@caliber/config";

// RFC 8628-style device authorization grant, state in Redis (zero schema).
// Spec: docs/superpowers/specs/2026-07-03-cli-login-resident-agent-design.md §2
const FLOW_TTL_SEC = 900;
const POLL_INTERVAL_SEC = 5;
const RATE_LIMIT_PER_MIN = 60;
// Unambiguous alphabet: no vowels (no accidental words), no 0/O/1/I.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
export const USER_CODE_RE = /^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/;

const startBodySchema = z.object({
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(255),
  agentVersion: z.string().max(64).optional(),
  cliVersion: z.string().max(64).optional(),
});
const pollBodySchema = z.object({ device_code: z.string().min(16).max(128) });

export const deviceAuthFlowSchema = z.object({
  status: z.enum(["pending", "approved", "denied"]),
  userCode: z.string(),
  hostname: z.string(),
  os: z.string(),
  agentVersion: z.string().optional(),
  cliVersion: z.string().optional(),
  createdAt: z.string(),
  enrollmentToken: z.string().optional(),
});
export type DeviceAuthFlow = z.infer<typeof deviceAuthFlowSchema>;

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
export function flowKey(deviceCodeHash: string): string {
  return `device-auth:${deviceCodeHash}`;
}
export function userCodeKey(userCode: string): string {
  return `device-auth:code:${userCode}`;
}
/** Uppercases, strips separators, re-inserts the dash: "abcd efgh" -> "ABCD-EFGH". */
export function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-9]/g, "");
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}
function generateUserCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i += 1) s += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function deviceAuthRoutes(env: ServerEnv, redis: Redis): FastifyPluginAsync {
  return async (fastify) => {
    // First rate-limited REST scope in api (trpc has its own); per-IP.
    await fastify.register(rateLimit, {
      max: RATE_LIMIT_PER_MIN,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });

    fastify.post("/v1/device-auth/start", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const parsed = startBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body", details: parsed.error.flatten() };
      }
      const deviceCode = randomBytes(32).toString("base64url");
      const codeHash = hashDeviceCode(deviceCode);
      const userCode = generateUserCode();
      const flow: DeviceAuthFlow = {
        status: "pending",
        userCode,
        ...parsed.data,
        createdAt: new Date().toISOString(),
      };
      await redis.set(flowKey(codeHash), JSON.stringify(flow), "EX", FLOW_TTL_SEC);
      await redis.set(userCodeKey(userCode), codeHash, "EX", FLOW_TTL_SEC);
      const verificationUri = `${env.NEXTAUTH_URL.replace(/\/$/, "")}/device`;
      reply.code(201);
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${userCode}`,
        interval: POLL_INTERVAL_SEC,
        expires_in: FLOW_TTL_SEC,
      };
    });

    fastify.post("/v1/device-auth/poll", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const parsed = pollBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const codeHash = hashDeviceCode(parsed.data.device_code);
      const raw = await redis.get(flowKey(codeHash));
      if (!raw) {
        reply.code(400);
        return { error: "expired_token" };
      }
      let flow: DeviceAuthFlow;
      try {
        flow = deviceAuthFlowSchema.parse(JSON.parse(raw));
      } catch {
        await redis.del(flowKey(codeHash)).catch(() => {});
        reply.code(400);
        return { error: "expired_token" };
      }
      if (flow.status === "denied") {
        await redis.del(flowKey(codeHash), userCodeKey(flow.userCode)).catch(() => {});
        reply.code(400);
        return { error: "access_denied" };
      }
      if (flow.status === "approved" && flow.enrollmentToken) {
        await redis.del(flowKey(codeHash), userCodeKey(flow.userCode)).catch(() => {});
        reply.code(200);
        return { enrollment_token: flow.enrollmentToken };
      }
      reply.code(400);
      return { error: "authorization_pending" };
    });
  };
}
