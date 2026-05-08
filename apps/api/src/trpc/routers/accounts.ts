import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { upstreamAccounts, credentialVault } from "@aide/db";
import { encryptCredential } from "@aide/gateway-core";
import { can } from "@aide/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { assertTeamBelongsToOrg } from "./_shared.js";

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

      return account;
    });

    return insertedRow;
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
      // back up immediately.
      await ctx.db
        .update(upstreamAccounts)
        .set({
          status: "active",
          schedulable: true,
          oauthRefreshFailCount: 0,
          oauthRefreshLastError: null,
          tempUnschedulableUntil: null,
          tempUnschedulableReason: null,
          updatedAt: rotatedAt,
        })
        .where(eq(upstreamAccounts.id, existing.id));

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
      return { ok: true as const };
    }),
});
