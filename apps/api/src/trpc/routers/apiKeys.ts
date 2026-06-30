import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { apiKeys, organizationMembers } from "@caliber/db";
import type { Database } from "@caliber/db";
import { generateApiKey, hashApiKey } from "@caliber/gateway-core";
import { can } from "@caliber/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";
import { assertTeamBelongsToOrg, assertGroupBelongsToOrg, resolveUserPrimaryOrgId } from "./_shared.js";
import { writeAudit } from "../../services/audit.js";

const uuid = z.string().uuid();

// Reveal-token TTL — must match the Redis EX value below so the DB row's
// expiration window stays in lockstep with the cache stash.
const REVEAL_TOKEN_TTL_SEC = 24 * 60 * 60;

// Redis key suffix (the ioredis client prepends `caliber:gw:` via keyPrefix).
function revealKey(token: string): string {
  return `key-reveal:${token}`;
}

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Centralizes the API_KEY_HASH_PEPPER presence check. The env schema requires
// this when the gateway is enabled, so reaching the throw branch indicates a
// misconfiguration upstream — guard so we never call hashApiKey with undefined.
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

// The one-time reveal page is a WEB route (apps/web/.../api-keys/reveal/[token]),
// served from the dashboard origin — NOT the gateway. Build the reveal URL from
// NEXTAUTH_URL (the app's public origin), trailing slash stripped.
// (Issue #192: this used GATEWAY_BASE_URL, which pointed the link at the gateway
// port — a Fastify proxy with no such route — so the link 404'd.)
function revealBaseUrl(env: { NEXTAUTH_URL: string }): string {
  return env.NEXTAUTH_URL.replace(/\/+$/, "");
}

// Generate a 32-byte URL-safe token. Used as the one-time secret in the admin
// reveal flow — the holder of this token can claim the raw key exactly once.
function generateRevealToken(): string {
  return randomBytes(32).toString("base64url");
}

// HMAC-SHA256 of the reveal token with the api-key pepper. We never store the
// token itself in the DB (that would defeat the one-time URL guarantee), only
// its HMAC so we can look up the row when the admin/user clicks the URL.
function hashRevealToken(pepperHex: string, token: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error("pepper must be 32 bytes hex (64 chars)");
  }
  return createHmac("sha256", Buffer.from(pepperHex, "hex"))
    .update(token)
    .digest("hex");
}


// Columns the API surfaces to non-admin callers. Excludes anything that
// could leak key material or expose internal reveal-flow bookkeeping.
const ownColumns = {
  id: apiKeys.id,
  prefix: apiKeys.keyPrefix,
  name: apiKeys.name,
  status: apiKeys.status,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  teamId: apiKeys.teamId,
  quotaUsd: apiKeys.quotaUsd,
  quotaUsedUsd: apiKeys.quotaUsedUsd,
  // Per-key "score as project" opt-in state (PR5). Surfaced so the management
  // UI can render/toggle it. Carries no key material — safe at the own scope.
  evaluateAsProject: apiKeys.evaluateAsProject,
} as const;

// Org-admin view adds ownership context (who owns the key, who issued it)
// but still excludes keyHash / revealTokenHash / revealedByIp.
//
// Reveal-status fields (no key material): non-null revealTokenExpiresAt with
// null revealedAt means "admin-issued, pending reveal"; non-null revealedAt
// means "claimed". Surfacing these lets the admin UI distinguish pending
// vs claimed without exposing any secret-derived value.
const orgColumns = {
  ...ownColumns,
  userId: apiKeys.userId,
  issuedByUserId: apiKeys.issuedByUserId,
  revealedAt: apiKeys.revealedAt,
  revealTokenExpiresAt: apiKeys.revealTokenExpiresAt,
} as const;

export const apiKeysRouter = router({
  // Member-level: the caller issues a key for themselves. Returns the raw
  // key exactly once — the API never persists plaintext, only the HMAC.
  issueOwn: permissionProcedure(
    z.object({
      name: z.string().min(1).max(255),
      teamId: uuid.nullable().optional(),
      // #191 — bind the key to an account group (routes to that group's
      // platform + accounts). null/omitted = legacy null-group → anthropic.
      groupId: uuid.nullable().optional(),
      // BYOK Task 6 — controls which upstream accounts are eligible for this key.
      routingPolicy: z.enum(["pool", "own", "own_then_pool"]).optional(),
    }),
    () => ({ type: "api_key.issue_own" }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const pepper = requirePepper(ctx.env);
    const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

    const routingPolicy = input.routingPolicy ?? "pool";
    // A non-pool routing policy targets user-owned accounts directly; combining
    // it with a groupId (which targets a shared account group) is semantically
    // contradictory. The DB also enforces this via CHECK, but we surface a
    // clean BAD_REQUEST here so callers get a useful message. Guard fires
    // before any DB round-trips so unconditionally invalid requests are
    // rejected immediately.
    if (routingPolicy !== "pool" && input.groupId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "routing_policy and group_id are mutually exclusive",
      });
    }

    // Cross-tenant integrity: if the caller pinned a team, it must live in
    // their resolved org. Without this a member could self-issue a key whose
    // team_id points at another org's team — corrupting routing/attribution.
    if (input.teamId) {
      await assertTeamBelongsToOrg(ctx.db, input.teamId, orgId);
    }
    // #191 — same cross-tenant guard for the bound account group.
    if (input.groupId) {
      await assertGroupBelongsToOrg(ctx.db, input.groupId, orgId);
    }

    const { raw, prefix } = generateApiKey();
    const keyHash = hashApiKey(pepper, raw);

    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        userId: ctx.user.id,
        orgId,
        teamId: input.teamId ?? null,
        groupId: input.groupId ?? null,
        keyHash,
        keyPrefix: prefix,
        name: input.name,
        status: "active",
        issuedByUserId: null,
        routingPolicy,
      })
      .returning({ id: apiKeys.id, prefix: apiKeys.keyPrefix });
    if (!row) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "failed to insert api_keys row",
      });
    }

    await writeAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "api_key.issued_own",
      targetType: "api_key",
      targetId: row.id,
      orgId,
      metadata: { name: input.name, prefix: row.prefix, teamId: input.teamId ?? null, groupId: input.groupId ?? null },
    });

    return { id: row.id, prefix: row.prefix, raw };
  }),

  // Org-admin issues a key for another user. The admin never sees the raw
  // value: a one-time reveal URL is returned which the target user can claim
  // exactly once within REVEAL_TOKEN_TTL_SEC. The raw is stashed in Redis
  // (under the gateway's `caliber:gw:` namespace) keyed by the random token.
  issueForUser: permissionProcedure(
    z.object({
      orgId: uuid,
      targetUserId: uuid,
      name: z.string().min(1).max(255),
      teamId: uuid.nullable().optional(),
      // #191 — bind the key to an account group (routes to that group's
      // platform + accounts). null/omitted = legacy null-group → anthropic.
      groupId: uuid.nullable().optional(),
    }),
    (_, input) => ({
      type: "api_key.issue_for_user",
      orgId: input.orgId,
      targetUserId: input.targetUserId,
    }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const pepper = requirePepper(ctx.env);
    const baseUrl = revealBaseUrl(ctx.env);

    // Cross-tenant integrity #1 — membership: RBAC only proves the caller is
    // an admin in `orgId`, not that `targetUserId` is actually a member of
    // that org. The api_keys schema has independent FKs to users and
    // organizations, so without this check an org-A admin could write a
    // {userId=X, orgId=A} row even though X has no relationship to A; X
    // could then claim the reveal URL and end up holding a credential
    // attributed to an org they don't belong to. FORBIDDEN (not NOT_FOUND)
    // because the caller already has perms in orgId — no existence leak.
    const [membership] = await ctx.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, input.targetUserId),
          eq(organizationMembers.orgId, input.orgId),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "targetUserId is not a member of orgId",
      });
    }

    // Cross-tenant integrity #2 — team-org binding: same independent-FK
    // problem on api_keys.team_id. Run AFTER the membership check so the
    // ordering of failures is deterministic when both inputs are bad.
    if (input.teamId) {
      await assertTeamBelongsToOrg(ctx.db, input.teamId, input.orgId);
    }
    // #191 — same cross-tenant guard for the bound account group.
    if (input.groupId) {
      await assertGroupBelongsToOrg(ctx.db, input.groupId, input.orgId);
    }

    const { raw, prefix } = generateApiKey();
    const keyHash = hashApiKey(pepper, raw);

    const token = generateRevealToken();
    const revealTokenHash = hashRevealToken(pepper, token);
    const revealTokenExpiresAt = new Date(
      Date.now() + REVEAL_TOKEN_TTL_SEC * 1000,
    );

    // Stash the raw in Redis FIRST. If the DB insert fails afterwards we'll
    // leave a 24h-TTL'd orphan in Redis, which is harmless (no DB row → the
    // reveal lookup can't find it). Doing it the other way (DB first) would
    // create a row whose raw can never be revealed if Redis is briefly down.
    await ctx.redis.set(revealKey(token), raw, "EX", REVEAL_TOKEN_TTL_SEC);

    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        userId: input.targetUserId,
        orgId: input.orgId,
        teamId: input.teamId ?? null,
        groupId: input.groupId ?? null,
        keyHash,
        keyPrefix: prefix,
        name: input.name,
        status: "active",
        issuedByUserId: ctx.user.id,
        revealTokenHash,
        revealTokenExpiresAt,
      })
      .returning({ id: apiKeys.id, prefix: apiKeys.keyPrefix });
    if (!row) {
      // Best-effort cleanup of the orphaned Redis stash. Log at warn so ops
      // can spot orphaned reveal stashes — the 24h TTL will eventually
      // evict, but a never-claimed orphan means the admin will have to
      // re-issue. The DB-insert failure itself is the primary signal; we
      // still throw INTERNAL_SERVER_ERROR after.
      await ctx.redis.del(revealKey(token)).catch((cleanupErr: unknown) => {
        ctx.logger.warn(
          {
            err: cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
            tokenPrefix: token.slice(0, 8),
          },
          "failed to clean up orphaned api-key reveal stash after db insert failure",
        );
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "failed to insert api_keys row",
      });
    }

    await writeAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "api_key.issued_for_user",
      targetType: "api_key",
      targetId: row.id,
      orgId: input.orgId,
      metadata: {
        targetUserId: input.targetUserId,
        name: input.name,
        prefix: row.prefix,
        teamId: input.teamId ?? null,
        groupId: input.groupId ?? null,
      },
    });

    return {
      id: row.id,
      prefix: row.prefix,
      revealUrl: `${baseUrl}/api-keys/reveal/${token}`,
    };
  }),

  // Claim the one-time reveal URL. Requires login AND that the caller is the
  // targetUser the key was issued for. The token is the secret; session
  // enforces ownership scope so a misdirected URL (admin sent it to the wrong
  // person) cannot be claimed by the wrong user. Single-use is enforced via
  // a CAS update on revealedAt. NOT_FOUND on userId mismatch — no existence
  // leak (the wrong recipient can't tell the token was valid for someone else).
  revealViaToken: protectedProcedure
    .input(z.object({ token: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const pepper = requirePepper(ctx.env);
      const tokenHash = hashRevealToken(pepper, input.token);

      const [row] = await ctx.db
        .select({
          id: apiKeys.id,
          prefix: apiKeys.keyPrefix,
          name: apiKeys.name,
          orgId: apiKeys.orgId,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.revealTokenHash, tokenHash),
            eq(apiKeys.userId, ctx.user.id),
            gt(apiKeys.revealTokenExpiresAt, sql`NOW()`),
            isNull(apiKeys.revealedAt),
            isNull(apiKeys.revokedAt),
          ),
        )
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      const raw = await ctx.redis.get(revealKey(input.token));
      if (!raw) {
        // Cache may have evicted earlier than the DB window allowed (e.g.
        // Redis restart). Surface as NOT_FOUND so we don't leak stash state.
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // CAS: only the first claimant flips revealedAt. Without the
      // `revealedAt IS NULL` predicate two concurrent readers could both
      // succeed and claim the same token.
      const updated = await ctx.db
        .update(apiKeys)
        .set({
          revealedAt: sql`NOW()`,
          revealedByIp: ctx.ipAddress,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(apiKeys.id, row.id), isNull(apiKeys.revealedAt)))
        .returning({ id: apiKeys.id });
      if (updated.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "token already revealed",
        });
      }

      // Best-effort: drop the stash so the URL can't even hit the cache
      // again. The CAS above is the authoritative single-use guard.
      await ctx.redis.del(revealKey(input.token)).catch(() => {});

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "api_key.revealed",
        targetType: "api_key",
        targetId: row.id,
        orgId: row.orgId,
        metadata: { name: row.name, prefix: row.prefix },
      });

      return { id: row.id, prefix: row.prefix, raw, name: row.name };
    }),

  // Member-level: list the caller's own active keys. Excludes anything
  // soft-revoked (revokedAt IS NOT NULL). No key material in the response.
  listOwn: permissionProcedure(z.object({}).optional(), () => ({
    type: "api_key.list_own",
  })).query(async ({ ctx }) => {
    ensureGatewayEnabled(ctx.env);
    const rows = await ctx.db
      .select(ownColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, ctx.user.id), isNull(apiKeys.revokedAt)));
    return rows;
  }),

  // Org-admin only: list every active key in the org. Used by admin UIs to
  // audit/rotate user-issued credentials. Optional `userId` narrows to a single
  // member — the admin per-user view passes this so the browser doesn't
  // receive metadata for unrelated org members. The RBAC action is still
  // `api_key.list_all` (org-wide read), so adding the filter is purely a
  // bandwidth/exposure reduction, not a privilege change.
  listOrg: permissionProcedure(
    z.object({ orgId: uuid, userId: uuid.optional() }),
    (_, input) => ({
      type: "api_key.list_all",
      orgId: input.orgId,
    }),
  ).query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const rows = await ctx.db
      .select(orgColumns)
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.orgId, input.orgId),
          isNull(apiKeys.revokedAt),
          input.userId ? eq(apiKeys.userId, input.userId) : undefined,
        ),
      );
    return rows;
  }),

  // Soft-revoke a key. The RBAC action carries the key's owner + org so the
  // permission layer can decide whether the caller is allowed (self-revoke
  // for the owner; org_admin for org-wide revoke). NOT_FOUND covers both
  // missing and already-revoked rows so we never leak existence.
  revoke: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({
          id: apiKeys.id,
          orgId: apiKeys.orgId,
          ownerUserId: apiKeys.userId,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, input.id))
        .limit(1);
      if (!existing || existing.revokedAt !== null) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (
        !can(ctx.perm, {
          type: "api_key.revoke",
          apiKeyId: existing.id,
          orgId: existing.orgId,
          ownerUserId: existing.ownerUserId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updated = await ctx.db
        .update(apiKeys)
        .set({ revokedAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(and(eq(apiKeys.id, input.id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (updated.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "api_key.revoked",
        targetType: "api_key",
        targetId: input.id,
        orgId: existing.orgId,
        metadata: { ownerUserId: existing.ownerUserId },
      });

      return { ok: true as const };
    }),

  // Per-key "score as project" opt-in toggle (PR5 + PR7 caps).
  // RBAC mirrors `revoke`: the key owner may toggle their own key, or an
  // org_admin any key in their org (enforced by the
  // `api_key.evaluate_as_project_set` action). NOT_FOUND covers
  // missing/already-revoked rows (no existence leak); FORBIDDEN when found but
  // the caller lacks permission — identical to `revoke`.
  //
  // PR7 caps (enforced only on enable; disable is always allowed):
  //   - EVALUATOR_MAX_PROJECT_KEYS_PER_USER: per-user opt-in limit.
  //   - MAX_PROJECT_KEYS_PER_ORG: per-org opt-in limit.
  // Re-enabling an already-opted-in key is idempotent — not counted again.
  setEvaluateAsProject: protectedProcedure
    .input(z.object({ id: uuid, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({
          id: apiKeys.id,
          orgId: apiKeys.orgId,
          ownerUserId: apiKeys.userId,
          revokedAt: apiKeys.revokedAt,
          evaluateAsProject: apiKeys.evaluateAsProject,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, input.id))
        .limit(1);
      if (!existing || existing.revokedAt !== null) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (
        !can(ctx.perm, {
          type: "api_key.evaluate_as_project_set",
          apiKeyId: existing.id,
          orgId: existing.orgId,
          ownerUserId: existing.ownerUserId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // PR7 — enforce opt-in count caps ONLY when enabling AND the key is not
      // already opted-in (idempotent re-enable must not count the key twice).
      if (input.enabled && !existing.evaluateAsProject) {
        // Per-user cap
        const maxPerUser = ctx.env.EVALUATOR_MAX_PROJECT_KEYS_PER_USER;
        const [userCountRow] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.userId, existing.ownerUserId),
              eq(apiKeys.evaluateAsProject, true),
              isNull(apiKeys.revokedAt),
            ),
          );
        if ((userCountRow?.n ?? 0) >= maxPerUser) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Per-user project evaluation limit reached (EVALUATOR_MAX_PROJECT_KEYS_PER_USER=${maxPerUser}). Disable another key first.`,
          });
        }

        // Per-org cap
        const maxPerOrg = ctx.env.MAX_PROJECT_KEYS_PER_ORG;
        const [orgCountRow] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.orgId, existing.orgId),
              eq(apiKeys.evaluateAsProject, true),
              isNull(apiKeys.revokedAt),
            ),
          );
        if ((orgCountRow?.n ?? 0) >= maxPerOrg) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Per-org project evaluation limit reached (MAX_PROJECT_KEYS_PER_ORG=${maxPerOrg}). Disable another key first.`,
          });
        }
      }

      await ctx.db
        .update(apiKeys)
        .set({ evaluateAsProject: input.enabled, updatedAt: sql`NOW()` })
        .where(eq(apiKeys.id, input.id));

      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "api_key.evaluate_as_project_set",
        targetType: "api_key",
        targetId: input.id,
        orgId: existing.orgId,
        metadata: {
          enabled: input.enabled,
          ownerUserId: existing.ownerUserId,
        },
      });

      return { ok: true as const };
    }),
});
