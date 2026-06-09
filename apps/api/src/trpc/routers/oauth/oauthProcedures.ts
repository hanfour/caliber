import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { upstreamAccounts, credentialVault } from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";
import { can } from "@caliber/auth";
import {
  resolveOAuthService,
  OAuthServiceUnavailableError,
} from "@caliber/gateway-core/oauth";
import { protectedProcedure } from "../../procedures.js";
import { parsePastedCode } from "./parsePastedCode.js";
import { resolveUserPrimaryOrgId, ensureGatewayEnabled } from "../_shared.js";
import {
  requireMasterKeyHex,
  buildCredentialPlaintext,
  parseOauthExpiresAt,
} from "../_credentials.js";
import { writeAudit } from "../../../services/audit.js";

const uuid = z.string().uuid();

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

/**
 * Self-service OAuth procedures for the manual-paste flow. Spread into the
 * accounts router so the public call path stays `accounts.initiateOAuth` /
 * `accounts.completeOAuth`. Extracted from accounts.ts to keep that router
 * under the file-size budget.
 */
export const oauthProcedures = {
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
          // Echo the original state — required by Anthropic's (Claude Code)
          // token endpoint. `state` here already equals input.flowId (the CSRF
          // check above enforces it), which is the state minted in initiateOAuth.
          state,
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

      if (flow.targetUpstreamId) {
        const [row] = await ctx.db
          .select({
            id: upstreamAccounts.id,
            userId: upstreamAccounts.userId,
            orgId: upstreamAccounts.orgId,
            platform: upstreamAccounts.platform,
            type: upstreamAccounts.type,
          })
          .from(upstreamAccounts)
          .where(
            and(
              eq(upstreamAccounts.id, flow.targetUpstreamId),
              isNull(upstreamAccounts.deletedAt),
            ),
          )
          .limit(1);
        // Collapse missing-row + not-owner into NOT_FOUND so a caller can't
        // enumerate other users' upstream IDs (matches Task 9 + the router's
        // anti-enumeration convention). The platform/type BAD_REQUEST below
        // only runs on rows the caller owns, so it leaks nothing cross-user.
        if (
          !row ||
          !can(ctx.perm, {
            type: "account.manage_own",
            ownerUserId: row.userId ?? "",
          })
        ) {
          // Code already spent at the provider; consume the flow-state.
          await ctx.redis.del(`oauth-flow:${input.flowId}`);
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        if (row.type !== "oauth" || row.platform !== flow.platform) {
          await ctx.redis.del(`oauth-flow:${input.flowId}`);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "target is not an oauth upstream of this platform",
          });
        }
        const sealed = encryptCredential({
          masterKeyHex,
          accountId: row.id,
          plaintext,
        });
        const rotatedAt = new Date();
        await ctx.db.transaction(async (tx) => {
          await tx
            .update(credentialVault)
            .set({
              nonce: sealed.nonce,
              ciphertext: sealed.ciphertext,
              authTag: sealed.authTag,
              oauthExpiresAt,
              rotatedAt,
            })
            .where(eq(credentialVault.accountId, row.id));
          await tx
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
            .where(eq(upstreamAccounts.id, row.id));
          await writeAudit(tx, {
            actorUserId: ctx.user.id,
            action: "account.oauth_reauthorized",
            targetType: "upstream_account",
            targetId: row.id,
            orgId: row.orgId,
            metadata: { platform: row.platform },
          });
        });
        await ctx.redis.del(`oauth-flow:${input.flowId}`);
        return { id: row.id };
      }

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
            // Denormalized expiry drives deriveAccountStatus("expired") in the
            // UI — mirror the admin `register` path so self-service oauth rows
            // surface their token lifetime + re-auth prompt symmetrically.
            expiresAt: oauthExpiresAt,
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
      // Return the same minimal shape as the re-auth arm so callers get a
      // consistent `{ id }` contract (the row carries no credential material;
      // the web wizard only needs success + the id).
      return { id: account.id };
    }),
};
