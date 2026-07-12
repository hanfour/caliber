import type { FastifyPluginAsync } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { can, resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  credentialVault,
  organizations,
  upstreamAccounts,
} from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";
import {
  OAuthServiceUnavailableError,
  resolveOAuthService,
} from "@caliber/gateway-core/oauth";
import { writeAudit } from "../services/audit.js";
import { AUDIT_ACTIONS } from "../services/auditActions.js";
import {
  buildCredentialPlaintext,
  parseOauthExpiresAt,
} from "../trpc/routers/_credentials.js";
import { parsePastedCode } from "../trpc/routers/oauth/parsePastedCode.js";
import { authenticateCliAccess } from "./cliAccess.js";

const FLOW_TTL_SEC = 600;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const startSchema = z.object({
  org: z.string().min(1).max(255),
  name: z.string().min(1).max(255).default("Claude subscription pool"),
  priority: z.number().int().min(0).max(1000).default(50),
  concurrency: z.number().int().min(1).max(1000).default(20),
});
const completeSchema = z.object({
  flow_id: z.string().min(1).max(128),
  pasted_value: z.string().min(1).max(10_000),
});
const flowSchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  priority: z.number().int().min(0).max(1000),
  concurrency: z.number().int().min(1).max(1000),
  codeVerifier: z.string(),
  redirectURI: z.string().url(),
});

function flowKey(state: string): string {
  return `cli-pool-oauth:${state}`;
}

function oauthService(env: ServerEnv) {
  try {
    return resolveOAuthService("anthropic", env);
  } catch (error) {
    if (error instanceof OAuthServiceUnavailableError) return null;
    throw error;
  }
}

export function cliAdminPoolRoutes(
  env: ServerEnv,
  redis: Redis,
): FastifyPluginAsync {
  return async (fastify) => {
    await fastify.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
    });

    fastify.post("/v1/cli/admin/pool/oauth/start", async (request, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const service = oauthService(env);
      if (!service) {
        reply.code(404);
        return { error: "anthropic_oauth_disabled" };
      }
      const access = await authenticateCliAccess(
        redis,
        request.headers.authorization,
      );
      if (!access.ok) {
        reply.code(401);
        return { error: access.error };
      }
      const parsed = startSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }

      const orgWhere = uuidPattern.test(parsed.data.org)
        ? eq(organizations.id, parsed.data.org)
        : eq(organizations.slug, parsed.data.org);
      const [org] = await fastify.db
        .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(and(orgWhere, isNull(organizations.deletedAt)))
        .limit(1);
      if (!org) {
        reply.code(404);
        return { error: "not_found" };
      }
      const permissions = await resolvePermissions(
        fastify.db,
        access.principal.userId,
      );
      if (
        !can(permissions, {
          type: "account.create",
          orgId: org.id,
          teamId: null,
        })
      ) {
        reply.code(403);
        return { error: "forbidden" };
      }

      const authorization = await service.generateAuthURL({});
      await redis.set(
        flowKey(authorization.state),
        JSON.stringify({
          userId: access.principal.userId,
          orgId: org.id,
          name: parsed.data.name,
          priority: parsed.data.priority,
          concurrency: parsed.data.concurrency,
          codeVerifier: authorization.codeVerifier,
          redirectURI: authorization.redirectURI,
        }),
        "EX",
        FLOW_TTL_SEC,
      );
      reply.code(201);
      return {
        flow_id: authorization.state,
        auth_url: authorization.authUrl,
        expires_in: FLOW_TTL_SEC,
        org,
      };
    });

    fastify.post("/v1/cli/admin/pool/oauth/complete", async (request, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const service = oauthService(env);
      if (!service) {
        reply.code(404);
        return { error: "anthropic_oauth_disabled" };
      }
      const access = await authenticateCliAccess(
        redis,
        request.headers.authorization,
      );
      if (!access.ok) {
        reply.code(401);
        return { error: access.error };
      }
      const parsed = completeSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const key = flowKey(parsed.data.flow_id);
      const rawFlow = await redis.get(key);
      const flowResult = (() => {
        try {
          return flowSchema.safeParse(rawFlow ? JSON.parse(rawFlow) : null);
        } catch {
          return flowSchema.safeParse(null);
        }
      })();
      if (!flowResult.success) {
        reply.code(400);
        return { error: "oauth_flow_expired" };
      }
      const flow = flowResult.data;
      if (flow.userId !== access.principal.userId) {
        reply.code(403);
        return { error: "forbidden" };
      }

      const masterKeyHex = env.CREDENTIAL_ENCRYPTION_KEY;
      if (!masterKeyHex) {
        reply.code(500);
        return { error: "credential_encryption_unavailable" };
      }
      const [activeOrg] = await fastify.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.id, flow.orgId),
            isNull(organizations.deletedAt),
          ),
        )
        .limit(1);
      if (!activeOrg) {
        reply.code(404);
        return { error: "not_found" };
      }
      const permissions = await resolvePermissions(fastify.db, flow.userId);
      if (
        !can(permissions, {
          type: "account.create",
          orgId: flow.orgId,
          teamId: null,
        })
      ) {
        reply.code(403);
        return { error: "forbidden" };
      }
      const pasted = parsePastedCode(parsed.data.pasted_value, "anthropic");
      if (!pasted.code || pasted.state !== parsed.data.flow_id) {
        reply.code(400);
        return { error: "invalid_oauth_callback" };
      }

      // Claim the validated flow exactly once before spending the provider's
      // one-time authorization code. Concurrent complete requests cannot both
      // create an account, even if the provider were to accept a replay.
      const claimed = await redis.getdel(key);
      if (!claimed || claimed !== rawFlow) {
        reply.code(400);
        return { error: "oauth_flow_expired" };
      }

      let tokens;
      try {
        tokens = await service.exchangeCode({
          code: pasted.code,
          state: pasted.state,
          codeVerifier: flow.codeVerifier,
          redirectURI: flow.redirectURI,
        });
      } catch {
        reply.code(400);
        return { error: "oauth_exchange_failed" };
      }
      const credentials = JSON.stringify({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt.toISOString(),
      });
      const oauthExpiresAt = parseOauthExpiresAt(credentials);

      const account = await fastify.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(upstreamAccounts)
          .values({
            orgId: flow.orgId,
            userId: null,
            teamId: null,
            name: flow.name,
            platform: "anthropic",
            type: "oauth",
            priority: flow.priority,
            concurrency: flow.concurrency,
            expiresAt: oauthExpiresAt,
          })
          .returning({ id: upstreamAccounts.id, name: upstreamAccounts.name });
        if (!created) throw new Error("failed to create pool account");

        const sealed = encryptCredential({
          masterKeyHex,
          accountId: created.id,
          plaintext: buildCredentialPlaintext("oauth", credentials),
        });
        await tx.insert(credentialVault).values({
          accountId: created.id,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt,
        });
        await writeAudit(tx, {
          actorUserId: flow.userId,
          action: AUDIT_ACTIONS.CLI_POOL_OAUTH_ADDED,
          targetType: "upstream_account",
          targetId: created.id,
          orgId: flow.orgId,
          metadata: {
            platform: "anthropic",
            type: "oauth",
            scope: "organization",
            name: flow.name,
          },
        });
        return created;
      });
      reply.code(201);
      return {
        id: account.id,
        name: account.name,
        platform: "anthropic",
        type: "oauth",
        scope: "organization",
        status: "active",
      };
    });
  };
}
