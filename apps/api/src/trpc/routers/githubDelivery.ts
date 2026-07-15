/**
 * GitHub delivery connection management (PR1, spec 2026-07-15).
 * Admin-gated via RBAC action github.manage (org_admin only).
 * The PAT is write-only: sealed with encryptCredential (salt = row id)
 * and never returned or logged. Queue constants are duplicated from the
 * gateway module (same precedent as reports.ts:27-28 — TODO @caliber/queue).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { can, type UserPermissions } from "@caliber/auth";
import { githubConnections } from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";
import { router } from "../procedures.js";
import { githubProcedure } from "./_githubGate.js";
import { requireMasterKeyHex } from "./_credentials.js";
import {
  probeGithubToken,
  GithubProbeError,
} from "../../services/githubProbe.js";

// ─── GitHub sync queue constants (duplicated from apps/gateway's
// workers/githubSync/queue.ts to avoid cross-app import) ──────────────────
// TODO: extract to a shared @caliber/queue package to eliminate this duplication.
const GITHUB_SYNC_JOB_NAME = "github-sync";
/** Keep in lockstep with apps/gateway/src/workers/githubSync/queue.ts. */
function buildGithubSyncJobId(input: { orgId: string }): string {
  return ["ghsync", "v1", input.orgId].join("_").replaceAll(":", "-");
}

export interface GithubSyncQueue {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
}

const orgIdInput = z.object({ orgId: z.string().uuid() });
const OWNER_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function assertCanManage(perm: UserPermissions, orgId: string): void {
  if (!can(perm, { type: "github.manage", orgId })) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

export const githubDeliveryRouter = router({
  setConnection: githubProcedure
    .input(
      orgIdInput.extend({
        ownerLogin: z.string().regex(OWNER_LOGIN_REGEX),
        token: z.string().min(20).max(255),
        repoAllowlist: z.array(z.string().min(3).max(200)).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCanManage(ctx.perm, input.orgId);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      let probe: { sampleRepo: string | null };
      try {
        probe = await probeGithubToken({
          token: input.token,
          ownerLogin: input.ownerLogin,
        });
      } catch (err) {
        if (err instanceof GithubProbeError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `github connection probe failed: ${err.reason}`,
          });
        }
        throw err;
      }

      const existing = (
        await ctx.db
          .select({ id: githubConnections.id })
          .from(githubConnections)
          .where(eq(githubConnections.orgId, input.orgId))
          .limit(1)
      )[0];
      // Salt binding: sealed with the row id — reuse it on update.
      const id = existing?.id ?? randomUUID();
      const sealed = encryptCredential({
        masterKeyHex,
        accountId: id,
        plaintext: input.token,
      });
      const tokenLast4 = input.token.slice(-4);

      await ctx.db
        .insert(githubConnections)
        .values({
          id,
          orgId: input.orgId,
          ownerLogin: input.ownerLogin,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          tokenLast4,
          repoAllowlist: input.repoAllowlist ?? null,
        })
        .onConflictDoUpdate({
          target: githubConnections.orgId,
          set: {
            ownerLogin: input.ownerLogin,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            tokenLast4,
            repoAllowlist: input.repoAllowlist ?? null,
            status: "ok",
            lastSyncError: null,
            updatedAt: new Date(),
          },
        });

      return {
        ownerLogin: input.ownerLogin,
        tokenLast4,
        sampleRepo: probe.sampleRepo,
      };
    }),

  getConnection: githubProcedure.input(orgIdInput).query(async ({ ctx, input }) => {
    assertCanManage(ctx.perm, input.orgId);
    const row = (
      await ctx.db
        .select({
          ownerLogin: githubConnections.ownerLogin,
          tokenLast4: githubConnections.tokenLast4,
          repoAllowlist: githubConnections.repoAllowlist,
          deliveryEnabled: githubConnections.deliveryEnabled,
          status: githubConnections.status,
          lastSyncAt: githubConnections.lastSyncAt,
          lastSyncError: githubConnections.lastSyncError,
        })
        .from(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .limit(1)
    )[0];
    return row ?? null;
  }),

  deleteConnection: githubProcedure
    .input(orgIdInput)
    .mutation(async ({ ctx, input }) => {
      assertCanManage(ctx.perm, input.orgId);
      const deleted = await ctx.db
        .delete(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .returning({ id: githubConnections.id });
      return { deleted: deleted.length > 0 };
    }),

  syncNow: githubProcedure.input(orgIdInput).mutation(async ({ ctx, input }) => {
    assertCanManage(ctx.perm, input.orgId);
    const exists = (
      await ctx.db
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.orgId, input.orgId))
        .limit(1)
    )[0];
    if (!exists) throw new TRPCError({ code: "NOT_FOUND" });

    const queue = ctx.githubSyncQueue;
    if (!queue) return { enqueued: false, testMode: true as const };

    const jobId = buildGithubSyncJobId({ orgId: input.orgId });
    await queue.add(
      GITHUB_SYNC_JOB_NAME,
      { orgId: input.orgId, triggeredBy: "manual" },
      { jobId },
    );
    return { enqueued: true as const, jobId };
  }),
});
