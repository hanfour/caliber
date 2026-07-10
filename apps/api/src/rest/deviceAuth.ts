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
// How many distinct user_codes to try before giving up (collision guard).
const USER_CODE_CLAIM_ATTEMPTS = 5;
const RATE_LIMIT_PER_MIN = 60;
// Unambiguous alphabet: no vowels (no accidental words), no 0/O/1/I.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
export const USER_CODE_RE = /^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/;

const startBodySchema = z.object({
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(255),
  agentVersion: z.string().max(64).optional(),
  cliVersion: z.string().max(64).optional(),
  // #256: `caliber login --gateway` opts into auto-provisioning an own_then_pool
  // gateway key at approval time so the CLI can configure Claude Code routing.
  provision_gateway: z.boolean().optional(),
});
const pollBodySchema = z.object({ device_code: z.string().min(16).max(128) });

export const deviceGatewayProvisioningSchema = z.object({
  requested: z.boolean(),
  status: z.enum([
    "not_requested",
    "provisioned",
    "already_exists",
    "unavailable",
    "failed",
  ]),
  gatewayUrl: z.string().optional(),
  errorCode: z.string().optional(),
});
export type DeviceGatewayProvisioning = z.infer<
  typeof deviceGatewayProvisioningSchema
>;

export const deviceAuthFlowSchema = z.object({
  status: z.enum(["pending", "approving", "approved", "denied"]),
  userCode: z.string(),
  hostname: z.string(),
  os: z.string(),
  agentVersion: z.string().optional(),
  cliVersion: z.string().optional(),
  createdAt: z.string(),
  approvalNonce: z.string().optional(),
  enrollmentToken: z.string().optional(),
  // #256: gateway provisioning — requested at start, fulfilled at approve.
  provisionGateway: z.boolean().optional(),
  gatewayProvisioning: deviceGatewayProvisioningSchema.optional(),
  apiKey: z.string().optional(),
  gatewayUrl: z.string().optional(),
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

function gatewayProvisioningPayload(flow: DeviceAuthFlow) {
  const provisioning = flow.gatewayProvisioning;
  if (!provisioning) return {};
  return {
    gateway: {
      requested: provisioning.requested,
      status: provisioning.status,
      ...(provisioning.gatewayUrl
        ? { gateway_url: provisioning.gatewayUrl }
        : {}),
      ...(provisioning.errorCode ? { error_code: provisioning.errorCode } : {}),
    },
  };
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
        // Bare error code only — do not echo zod's field-path shape (matches
        // the /poll handler and avoids leaking request-schema internals).
        reply.code(400);
        return { error: "invalid_body" };
      }
      const deviceCode = randomBytes(32).toString("base64url");
      const codeHash = hashDeviceCode(deviceCode);

      // Claim a user_code atomically with SET NX so a (vanishingly unlikely)
      // collision can never silently rebind another in-flight flow's index.
      let userCode = "";
      for (let attempt = 0; attempt < USER_CODE_CLAIM_ATTEMPTS; attempt += 1) {
        const candidate = generateUserCode();
        const claimed = await redis.set(
          userCodeKey(candidate),
          codeHash,
          "EX",
          FLOW_TTL_SEC,
          "NX",
        );
        if (claimed) {
          userCode = candidate;
          break;
        }
      }
      if (!userCode) {
        reply.code(500);
        return { error: "user_code_unavailable" };
      }
      const { provision_gateway, ...meta } = parsed.data;
      const flow: DeviceAuthFlow = {
        status: "pending",
        userCode,
        ...meta,
        provisionGateway: provision_gateway,
        createdAt: new Date().toISOString(),
      };
      await redis.set(flowKey(codeHash), JSON.stringify(flow), "EX", FLOW_TTL_SEC);
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
        return {
          enrollment_token: flow.enrollmentToken,
          ...gatewayProvisioningPayload(flow),
          // #256: present only when --gateway provisioning was requested and
          // a key was freshly minted at approve.
          ...(flow.apiKey ? { api_key: flow.apiKey, gateway_url: flow.gatewayUrl } : {}),
        };
      }
      reply.code(400);
      return { error: "authorization_pending" };
    });
  };
}
