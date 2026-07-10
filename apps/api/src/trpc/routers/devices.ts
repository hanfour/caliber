import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Redis } from "ioredis";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  apiKeys,
  devices,
  deviceEnrollmentTokens,
  organizations,
  type Database,
} from "@caliber/db";
import { can } from "@caliber/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { writeAudit } from "../../services/audit.js";
import { issueOwnGatewayKey } from "../../services/gatewayKeys.js";
import { resolveUserPrimaryOrgId } from "./_shared.js";
import { AUDIT_ACTIONS } from "../../services/auditActions.js";
import {
  flowKey,
  userCodeKey,
  normalizeUserCode,
  USER_CODE_RE,
  deviceAuthFlowSchema,
  type DeviceGatewayProvisioning,
  type DeviceAuthFlow,
} from "../../rest/deviceAuth.js";
import { clampInterval, AGENT_POLL_DEFAULT_SEC } from "../../rest/agentConfig.js";

const uuid = z.string().uuid();

// Enrollment token TTL — short, since the daemon redeems it immediately after
// the user pastes / scans it.
const ENROLLMENT_TOKEN_TTL_SEC = 60 * 60; // 1 hour

// Hash the bare enrollment token with the shared API_KEY_HASH_PEPPER so the
// DB never stores plaintext. Mirrors `hashRevealToken` in apiKeys.ts — same
// HMAC-SHA256 primitive.
export function hashEnrollmentToken(pepperHex: string, token: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error("pepper must be 32 bytes hex (64 chars)");
  }
  return createHmac("sha256", Buffer.from(pepperHex, "hex"))
    .update(token)
    .digest("hex");
}

// 32-byte URL-safe token presented to the daemon at enrollment. Same shape as
// the api-key reveal token so QR / paste / curl one-liner flows are uniform.
function generateEnrollmentToken(): string {
  return randomBytes(32).toString("base64url");
}

function requirePepper(env: { API_KEY_HASH_PEPPER?: string }): string {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "API_KEY_HASH_PEPPER not configured",
    });
  }
  return pepper;
}

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

const CLAIM_APPROVAL_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, flow = pcall(cjson.decode, raw)
if not ok or type(flow) ~= "table" then return 0 end
if flow.status ~= "pending" then return -1 end
flow.status = "approving"
flow.approvalNonce = ARGV[1]
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("PSETEX", KEYS[1], ttl, cjson.encode(flow))
else
  redis.call("SET", KEYS[1], cjson.encode(flow), "XX")
end
return 1
`;

const FINISH_APPROVAL_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, flow = pcall(cjson.decode, raw)
if not ok or type(flow) ~= "table" then return 0 end
if flow.status ~= "approving" or flow.approvalNonce ~= ARGV[1] then return -1 end
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("PSETEX", KEYS[1], ttl, ARGV[2])
else
  redis.call("SET", KEYS[1], ARGV[2], "XX")
end
return 1
`;

const RESET_APPROVAL_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, flow = pcall(cjson.decode, raw)
if not ok or type(flow) ~= "table" then return 0 end
if flow.status ~= "approving" or flow.approvalNonce ~= ARGV[1] then return -1 end
flow.status = "pending"
flow.approvalNonce = nil
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("PSETEX", KEYS[1], ttl, cjson.encode(flow))
else
  redis.call("SET", KEYS[1], cjson.encode(flow), "XX")
end
return 1
`;

const DENY_PENDING_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, flow = pcall(cjson.decode, raw)
if not ok or type(flow) ~= "table" then return 0 end
if flow.status ~= "pending" then return -1 end
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("PSETEX", KEYS[1], ttl, ARGV[1])
else
  redis.call("SET", KEYS[1], ARGV[1], "XX")
end
return 1
`;

async function evalFlowScript(
  redis: Redis,
  script: string,
  key: string,
  ...args: string[]
): Promise<number> {
  const result = await redis.eval(script, 1, key, ...args);
  const parsed = typeof result === "number" ? result : Number(result);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMissingLuaJson(err: unknown): boolean {
  return err instanceof Error && err.message.includes("global 'cjson'");
}

function approvalLockKey(codeHash: string): string {
  return `${flowKey(codeHash)}:approval-lock`;
}

async function setWithExistingTtl(
  redis: Redis,
  key: string,
  value: string,
): Promise<boolean> {
  const pttl = await redis.pttl(key);
  if (pttl === -2) return false;
  if (pttl > 0) {
    await redis.set(key, value, "PX", pttl);
    return true;
  }
  const stored = await redis.set(key, value, "XX");
  return Boolean(stored);
}

async function setLockWithFlowTtl(
  redis: Redis,
  codeHash: string,
  lockValue: string,
): Promise<boolean> {
  const pttl = await redis.pttl(flowKey(codeHash));
  if (pttl === -2) return false;
  const stored =
    pttl > 0
      ? await redis.set(approvalLockKey(codeHash), lockValue, "PX", pttl, "NX")
      : await redis.set(approvalLockKey(codeHash), lockValue, "NX");
  return Boolean(stored);
}

function parseFlow(raw: string | null): DeviceAuthFlow | null {
  if (!raw) return null;
  try {
    return deviceAuthFlowSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function claimApprovalFlowFallback(
  redis: Redis,
  codeHash: string,
  nonce: string,
): Promise<void> {
  const key = flowKey(codeHash);
  const flow = parseFlow(await redis.get(key));
  if (!flow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  if (flow.status !== "pending") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "already decided",
    });
  }
  const locked = await setLockWithFlowTtl(redis, codeHash, nonce);
  if (!locked) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "already decided",
    });
  }

  const latest = parseFlow(await redis.get(key));
  if (!latest) {
    await redis.del(approvalLockKey(codeHash)).catch(() => {});
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  if (latest.status !== "pending") {
    await redis.del(approvalLockKey(codeHash)).catch(() => {});
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "already decided",
    });
  }

  const stored = await setWithExistingTtl(
    redis,
    key,
    JSON.stringify({ ...latest, status: "approving", approvalNonce: nonce }),
  );
  if (!stored) {
    await redis.del(approvalLockKey(codeHash)).catch(() => {});
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
}

async function finishApprovalFlowFallback(
  redis: Redis,
  codeHash: string,
  nonce: string,
  approved: DeviceAuthFlow,
): Promise<boolean> {
  const key = flowKey(codeHash);
  if ((await redis.get(approvalLockKey(codeHash))) !== nonce) return false;
  const flow = parseFlow(await redis.get(key));
  if (
    !flow ||
    flow.status !== "approving" ||
    flow.approvalNonce !== nonce
  ) {
    return false;
  }
  const stored = await setWithExistingTtl(redis, key, JSON.stringify(approved));
  if (stored) await redis.del(approvalLockKey(codeHash)).catch(() => {});
  return stored;
}

async function resetApprovalFlowFallback(
  redis: Redis,
  codeHash: string,
  nonce: string,
): Promise<void> {
  const key = flowKey(codeHash);
  if ((await redis.get(approvalLockKey(codeHash))) !== nonce) return;
  const flow = parseFlow(await redis.get(key));
  if (flow?.status === "approving" && flow.approvalNonce === nonce) {
    const pending: DeviceAuthFlow = { ...flow, status: "pending" };
    delete pending.approvalNonce;
    await setWithExistingTtl(
      redis,
      key,
      JSON.stringify(pending),
    );
  }
  await redis.del(approvalLockKey(codeHash)).catch(() => {});
}

async function denyPendingFlowFallback(
  redis: Redis,
  codeHash: string,
  denied: DeviceAuthFlow,
): Promise<void> {
  const key = flowKey(codeHash);
  const flow = parseFlow(await redis.get(key));
  if (!flow || flow.status !== "pending") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: !flow ? "flow expired" : "already decided",
    });
  }

  const lockValue = `deny:${randomBytes(16).toString("hex")}`;
  const locked = await setLockWithFlowTtl(redis, codeHash, lockValue);
  if (!locked) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "already decided",
    });
  }
  const latest = parseFlow(await redis.get(key));
  if (!latest || latest.status !== "pending") {
    await redis.del(approvalLockKey(codeHash)).catch(() => {});
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: !latest ? "flow expired" : "already decided",
    });
  }
  const stored = await setWithExistingTtl(redis, key, JSON.stringify(denied));
  await redis.del(approvalLockKey(codeHash)).catch(() => {});
  if (!stored) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "flow expired",
    });
  }
}

async function claimApprovalFlow(
  redis: Redis,
  codeHash: string,
  nonce: string,
): Promise<void> {
  let result: number;
  try {
    result = await evalFlowScript(
      redis,
      CLAIM_APPROVAL_SCRIPT,
      flowKey(codeHash),
      nonce,
    );
  } catch (err) {
    if (isMissingLuaJson(err)) {
      await claimApprovalFlowFallback(redis, codeHash, nonce);
      return;
    }
    throw err;
  }
  if (result === 1) return;
  if (result === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "already decided",
  });
}

async function finishApprovalFlow(
  redis: Redis,
  codeHash: string,
  nonce: string,
  approved: DeviceAuthFlow,
): Promise<boolean> {
  let result: number;
  try {
    result = await evalFlowScript(
      redis,
      FINISH_APPROVAL_SCRIPT,
      flowKey(codeHash),
      nonce,
      JSON.stringify(approved),
    );
  } catch (err) {
    if (isMissingLuaJson(err)) {
      return finishApprovalFlowFallback(redis, codeHash, nonce, approved);
    }
    throw err;
  }
  return result === 1;
}

async function resetApprovalFlow(
  redis: Redis,
  codeHash: string,
  nonce: string,
): Promise<void> {
  try {
    await evalFlowScript(redis, RESET_APPROVAL_SCRIPT, flowKey(codeHash), nonce);
  } catch (err) {
    if (isMissingLuaJson(err)) {
      await resetApprovalFlowFallback(redis, codeHash, nonce);
      return;
    }
    throw err;
  }
}

async function denyPendingFlow(
  redis: Redis,
  codeHash: string,
  denied: DeviceAuthFlow,
): Promise<void> {
  let result: number;
  try {
    result = await evalFlowScript(
      redis,
      DENY_PENDING_SCRIPT,
      flowKey(codeHash),
      JSON.stringify(denied),
    );
  } catch (err) {
    if (isMissingLuaJson(err)) {
      await denyPendingFlowFallback(redis, codeHash, denied);
      return;
    }
    throw err;
  }
  if (result === 1) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: result === 0 ? "flow expired" : "already decided",
  });
}

async function cleanupApprovalSideEffects(
  db: Database,
  input: { enrollmentTokenId: string; apiKeyId?: string },
): Promise<void> {
  await db
    .delete(deviceEnrollmentTokens)
    .where(
      and(
        eq(deviceEnrollmentTokens.id, input.enrollmentTokenId),
        isNull(deviceEnrollmentTokens.usedAt),
      ),
    );

  if (input.apiKeyId) {
    await db
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: sql`NOW()`, updatedAt: sql`NOW()` })
      .where(and(eq(apiKeys.id, input.apiKeyId), isNull(apiKeys.revokedAt)));
  }
}

// Resolve a user_code (as typed/pasted by the operator on the /device page)
// to its pending Redis flow. Anti-enumeration: unknown, expired, or corrupt
// codes all collapse to the same NOT_FOUND — never distinguish "doesn't
// exist" from "exists but bad shape". A flow that's already been decided
// (approved/denied) is NOT retried here; approve/deny callers get
// PRECONDITION_FAILED so a second click doesn't silently no-op.
async function readPendingFlowWithHash(
  redis: Redis,
  rawUserCode: string,
): Promise<{ flow: DeviceAuthFlow; codeHash: string }> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!USER_CODE_RE.test(userCode)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  const codeHash = await redis.get(userCodeKey(userCode));
  if (!codeHash) throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  const raw = await redis.get(flowKey(codeHash));
  if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  let flow: DeviceAuthFlow;
  try {
    flow = deviceAuthFlowSchema.parse(JSON.parse(raw));
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  if (flow.status !== "pending") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "already decided" });
  }
  return { flow, codeHash };
}

async function readPendingFlow(
  redis: Redis,
  rawUserCode: string,
): Promise<DeviceAuthFlow> {
  return (await readPendingFlowWithHash(redis, rawUserCode)).flow;
}

// Member-visible columns — no token_hash, no key material.
const ownColumns = {
  id: devices.id,
  hostname: devices.hostname,
  os: devices.os,
  agentVersion: devices.agentVersion,
  enrolledAt: devices.enrolledAt,
  lastSeenAt: devices.lastSeenAt,
  status: devices.status,
  revokedAt: devices.revokedAt,
} as const;

// Org-admin view adds ownership context. Still no key material.
const orgColumns = {
  ...ownColumns,
  userId: devices.userId,
} as const;

export const devicesRouter = router({
  // List the caller's own devices. Revoked devices are excluded by default.
  listOwn: permissionProcedure(z.object({}).optional(), () => ({
    type: "device.list_own",
  })).query(async ({ ctx }) => {
    ensureGatewayEnabled(ctx.env);
    return ctx.db
      .select(ownColumns)
      .from(devices)
      .where(
        and(eq(devices.userId, ctx.user.id), isNull(devices.revokedAt)),
      )
      .orderBy(asc(devices.enrolledAt));
  }),

  // Org-admin: list every device in the org (excluding revoked).
  listAll: permissionProcedure(
    z.object({ orgId: uuid }),
    (_, input) => ({ type: "device.list_all", orgId: input.orgId }),
  ).query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    return ctx.db
      .select(orgColumns)
      .from(devices)
      .where(
        and(eq(devices.orgId, input.orgId), isNull(devices.revokedAt)),
      )
      .orderBy(asc(devices.enrolledAt));
  }),

  // Soft-revoke a device. Mirrors apiKeys.revoke: the action carries owner +
  // org so the permission layer decides self-revoke vs admin-revoke.
  // NOT_FOUND for missing or already-revoked.
  revoke: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          ownerUserId: devices.userId,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.id, input.id))
        .limit(1);
      if (!existing || existing.revokedAt !== null) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (
        !can(ctx.perm, {
          type: "device.revoke",
          deviceId: existing.id,
          orgId: existing.orgId,
          ownerUserId: existing.ownerUserId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updated = await ctx.db
        .update(devices)
        .set({ status: "revoked", revokedAt: sql`NOW()` })
        .where(and(eq(devices.id, input.id), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      if (updated.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "device.revoked",
        targetType: "device",
        targetId: input.id,
        orgId: existing.orgId,
        metadata: { ownerUserId: existing.ownerUserId },
      });

      return { ok: true as const };
    }),

  enrollmentToken: router({
    // Issue a one-shot enrollment token. Returns the bare token exactly once;
    // the DB only stores the HMAC. Caller's primary org is resolved from
    // membership (same approach as apiKeys.issueOwn).
    issue: permissionProcedure(z.object({}).optional(), () => ({
      type: "enrollment_token.issue_own",
    })).mutation(async ({ ctx }) => {
      ensureGatewayEnabled(ctx.env);
      const pepper = requirePepper(ctx.env);

      // Caller's primary org. Look up the earliest membership directly to
      // avoid a cross-router import (apiKeys.ts has the same helper, kept
      // private; if a third caller needs it we extract to _shared.ts).
      const membershipResult = await ctx.db.execute<{ org_id: string }>(
        sql`SELECT org_id FROM organization_members WHERE user_id = ${ctx.user.id} ORDER BY joined_at ASC LIMIT 1`,
      );
      const orgId = membershipResult.rows[0]?.org_id;
      if (!orgId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "user has no organization membership",
        });
      }

      const token = generateEnrollmentToken();
      const tokenHash = hashEnrollmentToken(pepper, token);
      const expiresAt = new Date(
        Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000,
      );

      const [row] = await ctx.db
        .insert(deviceEnrollmentTokens)
        .values({
          userId: ctx.user.id,
          orgId,
          tokenHash,
          expiresAt,
        })
        .returning({ id: deviceEnrollmentTokens.id });
      if (!row) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to insert enrollment token",
        });
      }

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "enrollment_token.issued",
        targetType: "enrollment_token",
        targetId: row.id,
        orgId,
        metadata: { expiresAt: expiresAt.toISOString() },
      });

      return {
        id: row.id,
        token,
        expiresAt: expiresAt.toISOString(),
      };
    }),

    // List the caller's pending (unused, unexpired) enrollment tokens. No
    // token material returned — id + expires_at + created_at only.
    listPending: protectedProcedure
      .query(async ({ ctx }) => {
        ensureGatewayEnabled(ctx.env);
        const now = new Date();
        return ctx.db
          .select({
            id: deviceEnrollmentTokens.id,
            expiresAt: deviceEnrollmentTokens.expiresAt,
            createdAt: deviceEnrollmentTokens.createdAt,
          })
          .from(deviceEnrollmentTokens)
          .where(
            and(
              eq(deviceEnrollmentTokens.userId, ctx.user.id),
              isNull(deviceEnrollmentTokens.usedAt),
              sql`${deviceEnrollmentTokens.expiresAt} > ${now}`,
            ),
          )
          .orderBy(asc(deviceEnrollmentTokens.createdAt));
      }),
  }),

  // Device-code authorization: the /device web page (session auth) approves a
  // CLI login flow started via POST /v1/device-auth/start. Approve mints the
  // SAME enrollment token the dashboard dialog issues, writing it into the
  // Redis flow so POST /v1/device-auth/poll can return it to the CLI.
  deviceAuth: router({
    lookup: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const flow = await readPendingFlow(ctx.redis, input.userCode);
        return {
          hostname: flow.hostname,
          os: flow.os,
          agentVersion: flow.agentVersion,
          cliVersion: flow.cliVersion,
        };
      }),

    approve: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const pepper = requirePepper(ctx.env);
        const { flow, codeHash } = await readPendingFlowWithHash(
          ctx.redis,
          input.userCode,
        );
        const approvalNonce = randomBytes(16).toString("hex");
        await claimApprovalFlow(ctx.redis, codeHash, approvalNonce);
        try {
          const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

          const token = generateEnrollmentToken();
          const tokenHash = hashEnrollmentToken(pepper, token);
          const expiresAt = new Date(
            Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000,
          );
          const [row] = await ctx.db
            .insert(deviceEnrollmentTokens)
            .values({ userId: ctx.user.id, orgId, tokenHash, expiresAt })
            .returning({ id: deviceEnrollmentTokens.id });
          if (!row) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "failed to insert enrollment token",
            });
          }

          // #256: when the CLI requested --gateway, mint an own_then_pool key
          // now (approval IS the user's consent) so poll can hand it back and the
          // CLI can configure Claude Code. Provisioning is non-fatal, but the
          // non-secret outcome is persisted so the CLI/operator can distinguish
          // "not requested" from "failed".
          let apiKey: string | undefined;
          let createdApiKeyId: string | undefined;
          let gatewayUrl: string | undefined;
          let gatewayProvisioning: DeviceGatewayProvisioning = {
            requested: false,
            status: "not_requested",
          };
          if (flow.provisionGateway) {
            if (!ctx.env.GATEWAY_BASE_URL) {
              gatewayProvisioning = {
                requested: true,
                status: "unavailable",
                errorCode: "gateway_url_not_configured",
              };
            } else {
              const keyName = `${flow.hostname} (caliber login)`;
              try {
                const issued = await issueOwnGatewayKey(ctx.db, {
                  userId: ctx.user.id,
                  orgId,
                  name: keyName,
                  pepper,
                });
                gatewayUrl = ctx.env.GATEWAY_BASE_URL;
                if (issued.created) {
                  apiKey = issued.rawKey;
                  createdApiKeyId = issued.id;
                  gatewayProvisioning = {
                    requested: true,
                    status: "provisioned",
                    gatewayUrl,
                  };
                } else {
                  gatewayProvisioning = {
                    requested: true,
                    status: "already_exists",
                    gatewayUrl,
                  };
                }
              } catch (err) {
                ctx.logger.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    hostname: flow.hostname,
                    orgId,
                    userId: ctx.user.id,
                  },
                  "device auth gateway key provisioning failed",
                );
                gatewayProvisioning = {
                  requested: true,
                  status: "failed",
                  gatewayUrl: ctx.env.GATEWAY_BASE_URL,
                  errorCode: "gateway_key_issue_failed",
                };
              }
            }
          }

          const approved: DeviceAuthFlow = {
            ...flow,
            status: "approved",
            enrollmentToken: token,
            gatewayProvisioning,
            ...(apiKey ? { apiKey, gatewayUrl } : {}),
          };
          const stored = await finishApprovalFlow(
            ctx.redis,
            codeHash,
            approvalNonce,
            approved,
          );
          if (!stored) {
            await cleanupApprovalSideEffects(ctx.db, {
              enrollmentTokenId: row.id,
              apiKeyId: createdApiKeyId,
            }).catch(() => {});
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "flow expired",
            });
          }

          await writeAudit(ctx.db, {
            actorUserId: ctx.user.id,
            action: AUDIT_ACTIONS.DEVICE_AUTH_APPROVED,
            targetType: "enrollment_token",
            targetId: row.id,
            orgId,
            metadata: {
              hostname: flow.hostname,
              os: flow.os,
              provisionGatewayRequested: gatewayProvisioning.requested,
              gatewayProvisioningStatus: gatewayProvisioning.status,
              ...(gatewayProvisioning.errorCode
                ? { gatewayProvisioningErrorCode: gatewayProvisioning.errorCode }
                : {}),
              ...(createdApiKeyId ? { gatewayKeyId: createdApiKeyId } : {}),
            },
          });
          return { ok: true as const };
        } catch (err) {
          await resetApprovalFlow(ctx.redis, codeHash, approvalNonce).catch(
            () => {},
          );
          throw err;
        }
      }),

    deny: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const { flow, codeHash } = await readPendingFlowWithHash(
          ctx.redis,
          input.userCode,
        );
        const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);
        const denied: DeviceAuthFlow = { ...flow, status: "denied" };
        await denyPendingFlow(ctx.redis, codeHash, denied);
        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: AUDIT_ACTIONS.DEVICE_AUTH_DENIED,
          orgId,
          metadata: { hostname: flow.hostname },
        });
        return { ok: true as const };
      }),
  }),

  // Org-admin resident-agent poll interval config. `get`/`set` both reuse the
  // device.list_all RBAC action (already org_admin-gated) rather than
  // introducing a new one purely for this setting.
  agentConfig: router({
    get: permissionProcedure(
      z.object({ orgId: uuid }),
      (_, input) => ({ type: "device.list_all", orgId: input.orgId }),
    ).query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ interval: organizations.agentPollIntervalSeconds })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      return { pollIntervalSeconds: row?.interval ?? AGENT_POLL_DEFAULT_SEC };
    }),

    set: permissionProcedure(
      z.object({ orgId: uuid, pollIntervalSeconds: z.number().int() }),
      (_, input) => ({ type: "device.list_all", orgId: input.orgId }),
    ).mutation(async ({ ctx, input }) => {
      const clamped = clampInterval(input.pollIntervalSeconds);
      await ctx.db
        .update(organizations)
        .set({ agentPollIntervalSeconds: clamped })
        .where(eq(organizations.id, input.orgId));
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: AUDIT_ACTIONS.DEVICE_AUTH_CONFIG_SET,
        orgId: input.orgId,
        metadata: { pollIntervalSeconds: clamped },
      });
      return { ok: true as const, pollIntervalSeconds: clamped };
    }),
  }),
});
