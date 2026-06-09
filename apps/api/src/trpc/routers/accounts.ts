import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { upstreamAccounts, credentialVault } from "@caliber/db";
import type { Database } from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";
import { can } from "@caliber/auth";
import {
  resolveOAuthService,
  OAuthServiceUnavailableError,
} from "@caliber/gateway-core/oauth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { parsePastedCode } from "./oauth/parsePastedCode.js";
import { assertTeamBelongsToOrg, resolveUserPrimaryOrgId } from "./_shared.js";
import { writeAudit } from "../../services/audit.js";

const uuid = z.string().uuid();
// API-key migration plan Phase 1 — `openai` joins as a first-class
// `accounts.create` platform. The gateway-side runtime (resolveCredential
// / scheduler / upstreamCallOpenai) is already type-agnostic; this only
// adds the validation surface so admins can onboard `sk-` keys obtained
// from a compliant OpenAI org / project.
const platformEnum = z.enum(["anthropic", "openai"]);
const typeEnum = z.enum(["api_key", "oauth"]);

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Centralizes the CREDENTIAL_ENCRYPTION_KEY presence check. The env schema
// requires this key whenever the gateway is enabled, so reaching the throw
// branch indicates a misconfiguration upstream — guard so we never call
// encryptCredential with undefined.
function requireMasterKeyHex(env: {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "CREDENTIAL_ENCRYPTION_KEY not configured",
    });
  }
  return key;
}

// Parse `expires_at` from an oauth credential payload. Accepts either an ISO
// 8601 string or a unix timestamp (seconds OR milliseconds). Returns null if
// missing or unparseable — caller decides whether that's acceptable.
// Shape the UI-supplied credential string into the JSON envelope the gateway
// expects. `resolveCredential` (apps/gateway/src/runtime/resolveCredential.ts)
// discriminates on a top-level `type` field and reads typed sub-fields off
// the same object — passing the user's raw string (either a bare `sk-ant-...`
// or an untagged OAuth JSON blob) would fail with `CredentialFormatError` at
// every request.
function buildCredentialPlaintext(
  type: "api_key" | "oauth",
  input: string,
): string {
  if (type === "api_key") {
    return JSON.stringify({ type: "api_key", api_key: input });
  }
  // oauth — merge user-pasted `{ access_token, refresh_token, expires_at, ... }`
  // with the authoritative `type: "oauth"` discriminator.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be valid JSON",
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be a JSON object",
    });
  }
  // Closes #73: the form hint is permissive about expires_at format
  // (ISO string OR unix ms OR unix seconds), but the gateway runtime's
  // `resolveCredential` only accepts ISO. Normalize at insert time so
  // the stored shape is always ISO regardless of what the operator
  // pasted.
  const merged: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    type: "oauth",
  };
  const canonicalExpiresAt = parseOauthExpiresAt(input);
  if (canonicalExpiresAt !== null) {
    merged.expires_at = canonicalExpiresAt.toISOString();
  }
  return JSON.stringify(merged);
}

function parseOauthExpiresAt(credentialsJson: string): Date | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be valid JSON",
    });
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>).expires_at;
  if (raw == null) return null;
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: anything below 10^12 is treated as seconds, otherwise ms.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms);
  }
  return null;
}


// Shape of the ephemeral OAuth flow-state stored in Redis by initiateOAuth.
// Parsed (not blindly cast) when read back in completeOAuth — Redis is an
// external boundary, so validate per the project coding-style rules.
const oauthFlowSchema = z.object({
  userId: z.string(),
  platform: z.enum(["openai", "anthropic"]),
  codeVerifier: z.string(),
  redirectURI: z.string(),
  targetUpstreamId: z.string().nullable(),
});

export const accountsRouter = router({
  list: permissionProcedure(
    // Optional `platform` narrows server-side so callers like
    // AccountGroupMembers (which only cares about a single platform) don't
    // have to pull every account in the org and filter client-side.
    // Backward-compatible: omitting `platform` returns the same superset.
    z.object({ orgId: uuid, platform: platformEnum.optional() }),
    (_, input) => ({
      type: "account.read",
      orgId: input.orgId,
    }),
  ).query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const rows = await ctx.db
      .select()
      .from(upstreamAccounts)
      .where(
        and(
          eq(upstreamAccounts.orgId, input.orgId),
          isNull(upstreamAccounts.deletedAt),
          input.platform !== undefined
            ? eq(upstreamAccounts.platform, input.platform)
            : undefined,
        ),
      );
    // upstream_accounts holds no credential material (that's in
    // credential_vault), so the SELECT * projection is safe to return as-is.
    return rows;
  }),

  get: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [row] = await ctx.db
        .select()
        .from(upstreamAccounts)
        .where(
          and(
            eq(upstreamAccounts.id, input.id),
            isNull(upstreamAccounts.deletedAt),
          ),
        )
        .limit(1);
      // Don't leak existence: NOT_FOUND covers both missing and forbidden.
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!can(ctx.perm, { type: "account.read", orgId: row.orgId })) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return row;
    }),

  create: permissionProcedure(
    z.object({
      orgId: uuid,
      teamId: uuid.nullable().optional(),
      name: z.string().min(1).max(255),
      platform: platformEnum,
      type: typeEnum,
      schedulable: z.boolean().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
      concurrency: z.number().int().min(1).max(1000).optional(),
      rateMultiplier: z.number().positive().max(10000).optional(),
      notes: z.string().max(10_000).optional(),
      credentials: z.string().min(1).max(100_000),
    }),
    (_, input) => ({
      type: "account.create",
      orgId: input.orgId,
      teamId: input.teamId ?? null,
    }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const masterKeyHex = requireMasterKeyHex(ctx.env);

    // Cross-tenant integrity: upstream_accounts.team_id is an independent FK
    // to teams; without this check an org-A admin could write a row with
    // org_id=A AND team_id=<team in org B>, corrupting team-scoped routing
    // and usage attribution.
    if (input.teamId) {
      await assertTeamBelongsToOrg(ctx.db, input.teamId, input.orgId);
    }

    let oauthExpiresAt: Date | null = null;
    if (input.type === "oauth") {
      oauthExpiresAt = parseOauthExpiresAt(input.credentials);
    }

    const insertedRow = await ctx.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(upstreamAccounts)
        .values({
          orgId: input.orgId,
          teamId: input.teamId ?? null,
          name: input.name,
          notes: input.notes ?? null,
          platform: input.platform,
          type: input.type,
          // For oauth, mirror the credential expiry onto the row the UI
          // reads. `parseOauthExpiresAt` returns null for api_key, so
          // this is a no-op there.
          expiresAt: oauthExpiresAt,
          schedulable: input.schedulable ?? true,
          priority: input.priority ?? 50,
          concurrency: input.concurrency ?? 3,
          rateMultiplier:
            input.rateMultiplier !== undefined
              ? input.rateMultiplier.toString()
              : "1.0",
        })
        .returning();
      if (!account) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to insert upstream account",
        });
      }

      const sealed = encryptCredential({
        masterKeyHex,
        accountId: account.id,
        plaintext: buildCredentialPlaintext(input.type, input.credentials),
      });

      await tx.insert(credentialVault).values({
        accountId: account.id,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        oauthExpiresAt,
      });

      await writeAudit(tx, {
        actorUserId: ctx.user.id,
        action: "account.created",
        targetType: "upstream_account",
        targetId: account.id,
        orgId: account.orgId,
        metadata: {
          name: account.name,
          platform: account.platform,
          type: account.type,
          teamId: account.teamId,
        },
      });

      return account;
    });

    return insertedRow;
  }),

  /**
   * Self-service mutation: any authenticated member can register their OWN
   * api_key upstream credential. The row is pinned to the caller's user id
   * and their primary org; teamId is always null (team-scope is an admin
   * concern). OAuth is a later phase — type is fixed to "api_key" here.
   */
  registerOwn: permissionProcedure(
    z.object({
      name: z.string().min(1).max(255),
      platform: platformEnum,
      type: z.literal("api_key"),
      credentials: z.string().min(1).max(100_000),
    }),
    () => ({ type: "account.register_own" as const }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const masterKeyHex = requireMasterKeyHex(ctx.env);
    const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

    const insertedRow = await ctx.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(upstreamAccounts)
        .values({
          orgId,
          userId: ctx.user.id,
          teamId: null,
          name: input.name,
          platform: input.platform,
          type: "api_key",
        })
        .returning();
      if (!account) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "failed to insert upstream account",
        });
      }

      const sealed = encryptCredential({
        masterKeyHex,
        accountId: account.id,
        plaintext: buildCredentialPlaintext("api_key", input.credentials),
      });

      await tx.insert(credentialVault).values({
        accountId: account.id,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        oauthExpiresAt: null,
      });

      await writeAudit(tx, {
        actorUserId: ctx.user.id,
        action: "account.registered_own",
        targetType: "upstream_account",
        targetId: account.id,
        orgId: account.orgId,
        metadata: {
          name: account.name,
          platform: account.platform,
          type: account.type,
        },
      });

      return account;
    });

    return insertedRow;
  }),

  /**
   * Returns all non-deleted upstreams owned by the calling user.
   */
  listOwn: permissionProcedure(z.void(), () => ({
    type: "account.register_own" as const,
  })).query(async ({ ctx }) => {
    ensureGatewayEnabled(ctx.env);
    return ctx.db
      .select()
      .from(upstreamAccounts)
      .where(
        and(
          eq(upstreamAccounts.userId, ctx.user.id),
          isNull(upstreamAccounts.deletedAt),
        ),
      )
      .orderBy(asc(upstreamAccounts.createdAt));
  }),

  /**
   * Metadata-only update (name / schedulable / priority) for the caller's own
   * upstream. Credentials are not touched — rotation = deleteOwn + registerOwn.
   * Ownership is enforced via the account.manage_own RBAC action so super_admin
   * keeps break-glass access.
   */
  updateOwn: permissionProcedure(
    z.object({
      id: uuid,
      name: z.string().min(1).max(255).optional(),
      schedulable: z.boolean().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
    }),
    () => ({ type: "account.register_own" as const }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const [existing] = await ctx.db
      .select()
      .from(upstreamAccounts)
      .where(
        and(
          eq(upstreamAccounts.id, input.id),
          isNull(upstreamAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (
      !existing ||
      !can(ctx.perm, {
        type: "account.manage_own",
        // null = admin/pool-owned row; "" never equals a real UUID, so members are correctly denied
        ownerUserId: existing.userId ?? "",
      })
    ) {
      throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });
    }
    const [row] = await ctx.db
      .update(upstreamAccounts)
      .set({
        name: input.name ?? existing.name,
        schedulable: input.schedulable ?? existing.schedulable,
        priority: input.priority ?? existing.priority,
        updatedAt: new Date(),
      })
      .where(eq(upstreamAccounts.id, input.id))
      .returning();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });

    await writeAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "account.updated_own",
      targetType: "upstream_account",
      targetId: input.id,
      orgId: existing.orgId,
      metadata: {
        name: row.name,
        schedulable: row.schedulable,
        priority: row.priority,
      },
    });

    return row;
  }),

  /**
   * In-place credential rotation for the caller's own upstream. Replaces the
   * encrypted secret in credential_vault WITHOUT deleting the upstream_accounts
   * row, so the account id and any associated usage history survive intact.
   * Ownership is enforced via account.manage_own (same as updateOwn/deleteOwn).
   * Only api_key is supported in P1 (mirrors registerOwn).
   */
  rotateOwn: permissionProcedure(
    z.object({
      id: uuid,
      credentials: z.string().min(1).max(100_000),
    }),
    () => ({ type: "account.register_own" as const }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const masterKeyHex = requireMasterKeyHex(ctx.env);

    const [existing] = await ctx.db
      .select()
      .from(upstreamAccounts)
      .where(
        and(
          eq(upstreamAccounts.id, input.id),
          isNull(upstreamAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (
      !existing ||
      !can(ctx.perm, {
        type: "account.manage_own",
        // null = admin/pool-owned row; "" never equals a real UUID, so members are correctly denied
        ownerUserId: existing.userId ?? "",
      })
    ) {
      throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });
    }

    const sealed = encryptCredential({
      masterKeyHex,
      accountId: existing.id,
      plaintext: buildCredentialPlaintext("api_key", input.credentials),
    });

    const rotatedAt = new Date();

    await ctx.db.transaction(async (tx) => {
      // UPDATE the existing vault row in-place — the unique constraint on
      // accountId guarantees exactly one row. Use .returning() to detect a
      // missing vault row (legacy data, partial fixture) instead of silently
      // no-oping.
      const updated = await tx
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          rotatedAt,
        })
        .where(eq(credentialVault.accountId, existing.id))
        .returning({ id: credentialVault.id });
      if (updated.length !== 1) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "credential_vault row missing for account",
        });
      }

      await tx
        .update(upstreamAccounts)
        .set({ updatedAt: rotatedAt })
        .where(eq(upstreamAccounts.id, existing.id));

      await writeAudit(tx, {
        actorUserId: ctx.user.id,
        action: "account.rotated_own",
        targetType: "upstream_account",
        targetId: existing.id,
        orgId: existing.orgId,
        metadata: {
          name: existing.name,
          platform: existing.platform,
        },
      });
    });

    return { id: existing.id, rotatedAt };
  }),

  /**
   * Soft-delete the caller's own upstream. Same ownership check via
   * account.manage_own RBAC action.
   */
  deleteOwn: permissionProcedure(
    z.object({ id: uuid }),
    () => ({ type: "account.register_own" as const }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const [existing] = await ctx.db
      .select()
      .from(upstreamAccounts)
      .where(
        and(
          eq(upstreamAccounts.id, input.id),
          isNull(upstreamAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (
      !existing ||
      !can(ctx.perm, {
        type: "account.manage_own",
        // null = admin/pool-owned row; "" never equals a real UUID, so members are correctly denied
        ownerUserId: existing.userId ?? "",
      })
    ) {
      throw new TRPCError({ code: "NOT_FOUND", message: "upstream not found" });
    }
    await ctx.db
      .update(upstreamAccounts)
      .set({ deletedAt: new Date() })
      .where(eq(upstreamAccounts.id, input.id));

    await writeAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "account.deleted_own",
      targetType: "upstream_account",
      targetId: input.id,
      orgId: existing.orgId,
      metadata: {
        name: existing.name,
        platform: existing.platform,
      },
    });

    return { id: input.id };
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: uuid,
        name: z.string().min(1).max(255).optional(),
        notes: z.string().max(10_000).nullable().optional(),
        schedulable: z.boolean().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        concurrency: z.number().int().min(1).max(1000).optional(),
        rateMultiplier: z.number().positive().max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({ id: upstreamAccounts.id, orgId: upstreamAccounts.orgId })
        .from(upstreamAccounts)
        .where(
          and(
            eq(upstreamAccounts.id, input.id),
            isNull(upstreamAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account.update",
          orgId: existing.orgId,
          accountId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.schedulable !== undefined)
        patch.schedulable = input.schedulable;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.concurrency !== undefined)
        patch.concurrency = input.concurrency;
      if (input.rateMultiplier !== undefined) {
        patch.rateMultiplier = input.rateMultiplier.toString();
      }

      const [row] = await ctx.db
        .update(upstreamAccounts)
        .set(patch)
        .where(eq(upstreamAccounts.id, input.id))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account.updated",
        targetType: "upstream_account",
        targetId: row.id,
        orgId: row.orgId,
        metadata: { fields: Object.keys(patch).filter((k) => k !== "updatedAt") },
      });

      return row;
    }),

  rotate: protectedProcedure
    .input(
      z.object({
        id: uuid,
        credentials: z.string().min(1).max(100_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      const [existing] = await ctx.db
        .select({
          id: upstreamAccounts.id,
          orgId: upstreamAccounts.orgId,
          type: upstreamAccounts.type,
        })
        .from(upstreamAccounts)
        .where(
          and(
            eq(upstreamAccounts.id, input.id),
            isNull(upstreamAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account.rotate",
          orgId: existing.orgId,
          accountId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      let oauthExpiresAt: Date | null = null;
      if (existing.type === "oauth") {
        oauthExpiresAt = parseOauthExpiresAt(input.credentials);
      }

      const sealed = encryptCredential({
        masterKeyHex,
        accountId: existing.id,
        plaintext: buildCredentialPlaintext(
          existing.type as "api_key" | "oauth",
          input.credentials,
        ),
      });

      const rotatedAt = new Date();
      // Use `.returning()` so we can verify a vault row actually existed for
      // this account. Without this, a missing row (legacy data, partial
      // migration, or fixtures that bypass `create`) would silently no-op
      // and we'd report success without persisting the new ciphertext.
      const updated = await ctx.db
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt,
          rotatedAt,
        })
        .where(eq(credentialVault.accountId, existing.id))
        .returning({ id: credentialVault.id });
      if (updated.length !== 1) {
        // From the caller's perspective, the credential they're trying to
        // rotate doesn't exist — surface NOT_FOUND rather than a 500.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "credential_vault row missing for account",
        });
      }

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account.rotated",
        targetType: "upstream_account",
        targetId: existing.id,
        orgId: existing.orgId,
        metadata: { type: existing.type },
      });

      return { id: existing.id, rotatedAt };
    }),

  /**
   * Re-onboard an OAuth account after it was auto-paused by
   * `oauth_invalid_grant` (issue #92 sub-task 2). Behaves like
   * `rotate`, but additionally:
   *
   * - Resets oauth_refresh_fail_count to 0
   * - Clears oauth_refresh_last_error / temp_unschedulable_reason /
   *   temp_unschedulable_until
   * - Sets status='active', schedulable=true
   *
   * Same RBAC + payload as rotate. Frontend uses this when surfacing
   * the "OAuth bundle rotated externally" banner so operators have a
   * one-click recovery instead of editing rows by hand.
   */
  reonboard: protectedProcedure
    .input(
      z.object({
        id: uuid,
        credentials: z.string().min(1).max(100_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      const [existing] = await ctx.db
        .select({
          id: upstreamAccounts.id,
          orgId: upstreamAccounts.orgId,
          type: upstreamAccounts.type,
        })
        .from(upstreamAccounts)
        .where(
          and(
            eq(upstreamAccounts.id, input.id),
            isNull(upstreamAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.type !== "oauth") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "reonboard only applies to oauth-type accounts",
        });
      }
      if (
        !can(ctx.perm, {
          type: "account.rotate",
          orgId: existing.orgId,
          accountId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const oauthExpiresAt = parseOauthExpiresAt(input.credentials);
      const sealed = encryptCredential({
        masterKeyHex,
        accountId: existing.id,
        plaintext: buildCredentialPlaintext("oauth", input.credentials),
      });

      const rotatedAt = new Date();
      const updated = await ctx.db
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt,
          rotatedAt,
        })
        .where(eq(credentialVault.accountId, existing.id))
        .returning({ id: credentialVault.id });
      if (updated.length !== 1) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "credential_vault row missing for account",
        });
      }

      // Reset failure state so the scheduler can pick this account
      // back up immediately. Also mirror the new expiry onto the
      // denormalised column the UI reads — otherwise the "Expired"
      // badge sticks even after a successful re-onboard.
      await ctx.db
        .update(upstreamAccounts)
        .set({
          status: "active",
          schedulable: true,
          expiresAt: oauthExpiresAt,
          oauthRefreshFailCount: 0,
          oauthRefreshLastError: null,
          tempUnschedulableUntil: null,
          tempUnschedulableReason: null,
          updatedAt: rotatedAt,
        })
        .where(eq(upstreamAccounts.id, existing.id));

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account.reonboarded",
        targetType: "upstream_account",
        targetId: existing.id,
        orgId: existing.orgId,
        metadata: {},
      });

      return { id: existing.id, rotatedAt };
    }),

  delete: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({ id: upstreamAccounts.id, orgId: upstreamAccounts.orgId })
        .from(upstreamAccounts)
        .where(
          and(
            eq(upstreamAccounts.id, input.id),
            isNull(upstreamAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        !can(ctx.perm, {
          type: "account.delete",
          orgId: existing.orgId,
          accountId: existing.id,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(upstreamAccounts)
        .set({
          deletedAt: sql`NOW()`,
          schedulable: false,
          updatedAt: sql`NOW()`,
        })
        .where(eq(upstreamAccounts.id, input.id));

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "account.deleted",
        targetType: "upstream_account",
        targetId: existing.id,
        orgId: existing.orgId,
        metadata: {},
      });

      return { ok: true as const };
    }),

  /**
   * Self-service OAuth — step 1 of the manual-paste flow. Generates a
   * platform auth URL (PKCE) and stashes the flow-state in redis keyed by
   * the opaque `state` so completeOAuth (step 2) can finish the exchange
   * with the SAME codeVerifier / redirectURI.
   *
   * RBAC is conditional (hence protectedProcedure, not permissionProcedure):
   * - self-create needs `account.register_own`;
   * - re-authorize (targetUpstreamId given) additionally requires
   *   `account.manage_own` over that row, plus platform/type/not-deleted
   *   consistency checked up-front (fail fast).
   */
  initiateOAuth: protectedProcedure
    .input(
      z.object({
        platform: z.enum(["openai", "anthropic"]),
        targetUpstreamId: uuid.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      if (!can(ctx.perm, { type: "account.register_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      // Re-auth: validate target ownership + platform up-front (fail fast).
      if (input.targetUpstreamId) {
        const [row] = await ctx.db
          .select({
            id: upstreamAccounts.id,
            userId: upstreamAccounts.userId,
            platform: upstreamAccounts.platform,
            type: upstreamAccounts.type,
          })
          .from(upstreamAccounts)
          .where(
            and(
              eq(upstreamAccounts.id, input.targetUpstreamId),
              isNull(upstreamAccounts.deletedAt),
            ),
          )
          .limit(1);
        // Collapse missing-row and not-owner into a single NOT_FOUND so a
        // caller can't enumerate other users' upstream IDs (matches the
        // anti-enumeration posture elsewhere in this router). The platform/
        // type BAD_REQUEST below only runs on rows the caller owns, so it
        // leaks nothing cross-user.
        if (
          !row ||
          !can(ctx.perm, {
            type: "account.manage_own",
            ownerUserId: row.userId ?? "",
          })
        ) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        if (row.type !== "oauth" || row.platform !== input.platform) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "target is not an oauth upstream of this platform",
          });
        }
      }
      let service;
      try {
        service = resolveOAuthService(input.platform, ctx.env);
      } catch (err) {
        if (err instanceof OAuthServiceUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        throw err;
      }
      const { authUrl, state, codeVerifier, redirectURI } =
        await service.generateAuthURL({});
      const payload = JSON.stringify({
        userId: ctx.user.id,
        platform: input.platform,
        codeVerifier,
        redirectURI,
        targetUpstreamId: input.targetUpstreamId ?? null,
      });
      await ctx.redis.set(`oauth-flow:${state}`, payload, "EX", 600);
      return { authUrl, flowId: state };
    }),

  /**
   * Self-service OAuth — step 2 of the manual-paste flow. Reads the redis
   * flow-state, validates the pasted code/state (CSRF), exchanges the code
   * for a TokenSet, and (first-connect) inserts a NEW user-owned oauth
   * upstream + credential_vault row. The re-authorize branch (re-using an
   * existing upstream pointed at by flow.targetUpstreamId) is added in Task 11.
   */
  completeOAuth: protectedProcedure
    .input(
      z.object({
        flowId: z.string().min(1).max(64),
        pastedValue: z.string().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      const raw = await ctx.redis.get(`oauth-flow:${input.flowId}`);
      if (!raw) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "oauth flow expired — please start again",
        });
      }
      const flowParsed = oauthFlowSchema.safeParse(
        ((): unknown => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })(),
      );
      if (!flowParsed.success) {
        // Corrupt / unexpected payload — treat like an expired flow.
        await ctx.redis.del(`oauth-flow:${input.flowId}`);
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "oauth flow expired — please start again",
        });
      }
      const flow = flowParsed.data;
      if (flow.userId !== ctx.user.id) {
        // Not the caller's flow — do NOT delete it (avoid griefing the real
        // owner's in-flight flow).
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const { code, state } = parsePastedCode(input.pastedValue, flow.platform);
      if (!code || state !== input.flowId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "invalid authorization code or state",
        });
      }

      let service;
      try {
        service = resolveOAuthService(flow.platform, ctx.env);
      } catch (err) {
        if (err instanceof OAuthServiceUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        throw err;
      }

      let tokens;
      try {
        tokens = await service.exchangeCode({
          code,
          codeVerifier: flow.codeVerifier,
          redirectURI: flow.redirectURI,
        });
      } catch (err) {
        // Terminal failure: the authorization code is single-use at the
        // provider, so this flow can't succeed on retry — consume the
        // flow-state to close any replay window. Log for diagnosis (the
        // provider error body is never surfaced to the client).
        ctx.logger.warn({ err }, "oauth exchangeCode failed");
        await ctx.redis.del(`oauth-flow:${input.flowId}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "authorization code invalid or expired",
        });
      }

      const credentialsJson = JSON.stringify({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt.toISOString(),
      });
      const oauthExpiresAt = parseOauthExpiresAt(credentialsJson);
      const plaintext = buildCredentialPlaintext("oauth", credentialsJson);

      // (Task 11 inserts the re-auth branch here, before first-connect.)

      const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);
      const account = await ctx.db.transaction(async (tx) => {
        const [acct] = await tx
          .insert(upstreamAccounts)
          .values({
            orgId,
            userId: ctx.user.id,
            teamId: null,
            name: `${flow.platform} OAuth`,
            platform: flow.platform,
            type: "oauth",
          })
          .returning();
        if (!acct) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "failed to insert upstream account",
          });
        }
        const sealed = encryptCredential({
          masterKeyHex,
          accountId: acct.id,
          plaintext,
        });
        await tx.insert(credentialVault).values({
          accountId: acct.id,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt,
        });
        await writeAudit(tx, {
          actorUserId: ctx.user.id,
          action: "account.oauth_connected",
          targetType: "upstream_account",
          targetId: acct.id,
          orgId: acct.orgId,
          metadata: { platform: acct.platform },
        });
        return acct;
      });

      await ctx.redis.del(`oauth-flow:${input.flowId}`);
      return account;
    }),
});
