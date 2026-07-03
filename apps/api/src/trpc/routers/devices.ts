import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { devices, deviceEnrollmentTokens } from "@caliber/db";
import { can } from "@caliber/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { writeAudit } from "../../services/audit.js";
import { resolveUserPrimaryOrgId } from "./_shared.js";
import { AUDIT_ACTIONS } from "../../services/auditActions.js";
import {
  flowKey,
  userCodeKey,
  normalizeUserCode,
  USER_CODE_RE,
  deviceAuthFlowSchema,
  type DeviceAuthFlow,
} from "../../rest/deviceAuth.js";

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

// Resolve a user_code (as typed/pasted by the operator on the /device page)
// to its pending Redis flow. Anti-enumeration: unknown, expired, or corrupt
// codes all collapse to the same NOT_FOUND — never distinguish "doesn't
// exist" from "exists but bad shape". A flow that's already been decided
// (approved/denied) is NOT retried here; approve/deny callers get
// PRECONDITION_FAILED so a second click doesn't silently no-op.
async function readPendingFlowWithHash(
  redis: import("ioredis").Redis,
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
  redis: import("ioredis").Redis,
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
        const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

        const token = generateEnrollmentToken();
        const tokenHash = hashEnrollmentToken(pepper, token);
        const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000);
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

        const approved: DeviceAuthFlow = {
          ...flow,
          status: "approved",
          enrollmentToken: token,
        };
        const ttl = await ctx.redis.ttl(flowKey(codeHash));
        await ctx.redis.set(
          flowKey(codeHash),
          JSON.stringify(approved),
          "EX",
          ttl > 0 ? ttl : 60,
        );

        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: AUDIT_ACTIONS.DEVICE_AUTH_APPROVED,
          targetType: "enrollment_token",
          targetId: row.id,
          orgId,
          metadata: { hostname: flow.hostname, os: flow.os },
        });
        return { ok: true as const };
      }),

    deny: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const { flow, codeHash } = await readPendingFlowWithHash(
          ctx.redis,
          input.userCode,
        );
        const denied: DeviceAuthFlow = { ...flow, status: "denied" };
        const ttl = await ctx.redis.ttl(flowKey(codeHash));
        await ctx.redis.set(
          flowKey(codeHash),
          JSON.stringify(denied),
          "EX",
          ttl > 0 ? ttl : 60,
        );
        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: AUDIT_ACTIONS.DEVICE_AUTH_DENIED,
          orgId: null,
          metadata: { hostname: flow.hostname },
        });
        return { ok: true as const };
      }),
  }),
});
