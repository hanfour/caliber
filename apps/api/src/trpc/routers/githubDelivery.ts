/**
 * GitHub delivery connection management (PR1) + report/activity reads and
 * on-demand generation (PR2, spec 2026-07-15).
 * Connection management + `generate` are admin-gated via RBAC action
 * github.manage (org_admin only). `getReport`/`listActivity` are gated via
 * delivery.read_user (self or org_admin). The PAT is write-only: sealed with
 * encryptCredential (salt = row id) and never returned or logged. Report
 * reads use explicit safe-field selects — llm columns beyond llmStatus are
 * never selected. Queue constants are duplicated from the gateway module
 * (same precedent as reports.ts:27-28 — TODO @caliber/queue).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { can, type UserPermissions } from "@caliber/auth";
import {
  accounts,
  githubConnections,
  githubDeliveryReports,
  githubIssues,
  githubPullRequests,
  githubReviews,
} from "@caliber/db";
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
  /**
   * Optional: BullMQ's real `Queue#remove` (see syncNow below). Optional so
   * fakes/test doubles that don't implement it still typecheck.
   */
  remove?(jobId: string): Promise<unknown>;
}

// ─── GitHub delivery queue constants (duplicated from apps/gateway's
// workers/githubDelivery/queue.ts to avoid cross-app import) ──────────────
// TODO: extract to a shared @caliber/queue package to eliminate this duplication.
const GITHUB_DELIVERY_JOB_NAME = "github-delivery";
const MAX_GENERATE_WINDOW_DAYS = 92;
/** Keep in lockstep with apps/gateway/src/workers/githubDelivery/queue.ts. */
function buildGithubDeliveryJobId(input: {
  orgId: string;
  userId: string;
  periodStart: string;
}): string {
  return ["ghdel", "v1", input.orgId, input.userId, input.periodStart]
    .join("_")
    .replaceAll(":", "-");
}

export interface GithubDeliveryQueue {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
  /**
   * Optional: BullMQ's real `Queue#remove` (see generate below). Optional so
   * fakes/test doubles that don't implement it still typecheck.
   */
  remove?(jobId: string): Promise<unknown>;
}

const orgIdInput = z.object({ orgId: z.string().uuid() });
const OWNER_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const dateInput = z.string().datetime();

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

      const tokenLast4 = input.token.slice(-4);

      // Salt-binding TOCTOU: the SELECT below and the upsert are not atomic,
      // so two concurrent first-writes for the same org can each generate
      // their own randomUUID() and encrypt with different salts. Whichever
      // INSERT loses the race resolves as an UPDATE against the WINNER's row
      // id, which would overwrite the ciphertext with bytes sealed under the
      // loser's (never-persisted) salt — an undecryptable PAT, since the
      // gateway derives the salt from the persisted row id. Wrapping in a
      // transaction and reading back the id the upsert actually kept (via
      // RETURNING) lets us detect that divergence and self-heal: re-encrypt
      // with the real persisted id and overwrite the sealed columns. This is
      // safe without extra locking because ON CONFLICT DO UPDATE already
      // takes a row-level lock on the conflicting row that is held for the
      // rest of this transaction, so no third writer can interleave between
      // the divergence check and the corrective UPDATE below.
      await ctx.db.transaction(async (tx) => {
        const existing = (
          await tx
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

        const [upserted] = await tx
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
          })
          .returning({ id: githubConnections.id });
        if (!upserted) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "failed to upsert github connection",
          });
        }
        const persistedId = upserted.id;

        if (persistedId !== id) {
          const resealed = encryptCredential({
            masterKeyHex,
            accountId: persistedId,
            plaintext: input.token,
          });
          await tx
            .update(githubConnections)
            .set({
              nonce: resealed.nonce,
              ciphertext: resealed.ciphertext,
              authTag: resealed.authTag,
              updatedAt: new Date(),
            })
            .where(eq(githubConnections.id, persistedId));
        }
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
    // BullMQ dedups `add` against the job hash for any jobId that still
    // exists — including completed/failed jobs, not just active ones — and
    // our jobId has no time component. Without removing the stale hash
    // first, a second syncNow (or the interval tick) after the first job
    // completes would silently no-op forever. `remove` is a no-op for an
    // active/locked job, so an in-flight sync still correctly dedups the
    // add that follows it. Best-effort: a remove failure must never block
    // the add. (Keep in lockstep with apps/gateway's enqueueGithubSync.)
    try {
      await queue.remove?.(jobId);
    } catch {
      // swallow — see comment above.
    }
    await queue.add(
      GITHUB_SYNC_JOB_NAME,
      { orgId: input.orgId, triggeredBy: "manual" },
      { jobId },
    );
    return { enqueued: true as const, jobId };
  }),

  generate: githubProcedure
    .input(
      orgIdInput.extend({
        userId: z.string().uuid(),
        from: dateInput,
        to: dateInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCanManage(ctx.perm, input.orgId);

      const fromMs = new Date(input.from).getTime();
      const toMs = new Date(input.to).getTime();
      if (toMs <= fromMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "to must be after from",
        });
      }
      const windowLimitMs = MAX_GENERATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      if (toMs - fromMs > windowLimitMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Window exceeds 92 days",
        });
      }

      const exists = (
        await ctx.db
          .select({ id: githubConnections.id })
          .from(githubConnections)
          .where(eq(githubConnections.orgId, input.orgId))
          .limit(1)
      )[0];
      if (!exists) throw new TRPCError({ code: "NOT_FOUND" });

      const queue = ctx.githubDeliveryQueue;
      if (!queue) return { enqueued: false, testMode: true as const };

      const payload = {
        orgId: input.orgId,
        userId: input.userId,
        periodStart: input.from,
        periodEnd: input.to,
        periodType: "daily" as const,
        triggeredBy: "manual" as const,
      };
      const jobId = buildGithubDeliveryJobId({
        orgId: input.orgId,
        userId: input.userId,
        periodStart: input.from,
      });
      // Regenerate semantics: remove the stale completed/failed job hash
      // before adding, so a re-run for the same (org, user, window) isn't
      // silently deduped against a prior run. `remove` no-ops on an
      // active/locked job, so an in-flight generation still dedups the add
      // that follows it. Best-effort: a remove failure must never block the
      // add. (Keep in lockstep with apps/gateway's enqueueGithubDelivery.)
      try {
        await queue.remove?.(jobId);
      } catch {
        // swallow — see comment above.
      }
      await queue.add(GITHUB_DELIVERY_JOB_NAME, payload, { jobId });
      return { enqueued: true as const, jobId };
    }),

  getReport: githubProcedure
    .input(
      orgIdInput.extend({
        userId: z.string().uuid(),
        from: dateInput,
        to: dateInput,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "delivery.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const row = (
        await ctx.db
          .select({
            id: githubDeliveryReports.id,
            periodStart: githubDeliveryReports.periodStart,
            periodEnd: githubDeliveryReports.periodEnd,
            periodType: githubDeliveryReports.periodType,
            totalScore: githubDeliveryReports.totalScore,
            insufficientData: githubDeliveryReports.insufficientData,
            sectionScores: githubDeliveryReports.sectionScores,
            metrics: githubDeliveryReports.metrics,
            llmStatus: githubDeliveryReports.llmStatus,
            triggeredBy: githubDeliveryReports.triggeredBy,
            updatedAt: githubDeliveryReports.updatedAt,
          })
          .from(githubDeliveryReports)
          .where(
            and(
              eq(githubDeliveryReports.orgId, input.orgId),
              eq(githubDeliveryReports.userId, input.userId),
              lte(githubDeliveryReports.periodStart, new Date(input.to)),
              gte(githubDeliveryReports.periodEnd, new Date(input.from)),
            ),
          )
          .orderBy(desc(githubDeliveryReports.periodStart))
          .limit(1)
      )[0];
      return row ?? null;
    }),

  listActivity: githubProcedure
    .input(
      orgIdInput.extend({
        userId: z.string().uuid(),
        from: dateInput,
        to: dateInput,
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "delivery.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // Resolve the member's GitHub numeric id via the same accounts join as
      // apps/gateway/src/workers/githubDelivery/fetchActivity.ts's
      // resolveGithubUserId (duplicated inline — apps/api can't import the
      // gateway module). Keep in lockstep with that function.
      const account = (
        await ctx.db
          .select({ providerAccountId: accounts.providerAccountId })
          .from(accounts)
          .where(
            and(eq(accounts.userId, input.userId), eq(accounts.provider, "github")),
          )
          .limit(1)
      )[0];
      const ghUserId = account ? Number(account.providerAccountId) : NaN;
      if (!account || !Number.isFinite(ghUserId)) {
        return { ghUserId: null, pulls: [], issues: [], reviews: [] };
      }

      const from = new Date(input.from);
      const to = new Date(input.to);

      const pulls = await ctx.db
        .select({
          repoFullName: githubPullRequests.repoFullName,
          number: githubPullRequests.number,
          title: githubPullRequests.title,
          htmlUrl: githubPullRequests.htmlUrl,
          state: githubPullRequests.state,
          ghCreatedAt: githubPullRequests.ghCreatedAt,
          mergedAt: githubPullRequests.mergedAt,
          additions: githubPullRequests.additions,
          deletions: githubPullRequests.deletions,
          changedFiles: githubPullRequests.changedFiles,
        })
        .from(githubPullRequests)
        .where(
          and(
            eq(githubPullRequests.orgId, input.orgId),
            eq(githubPullRequests.authorGhId, ghUserId),
            // nulls-last omitted deliberately: a merged-only filter already
            // excludes NULL mergedAt rows, so ordering desc never surfaces one.
            isNotNull(githubPullRequests.mergedAt),
            gte(githubPullRequests.mergedAt, from),
            lte(githubPullRequests.mergedAt, to),
          ),
        )
        .orderBy(desc(githubPullRequests.mergedAt))
        .limit(input.limit);

      // Issues: fetch org+window rows (indexed on org_id, closed_at), then
      // TS-filter for closer-or-assignee — assigneeGhIds jsonb membership
      // isn't SQL-narrowable without an unnest, and this is the same
      // pragmatism apps/gateway's worker uses (fetchActivity.ts).
      const issueRows = await ctx.db
        .select({
          repoFullName: githubIssues.repoFullName,
          number: githubIssues.number,
          title: githubIssues.title,
          htmlUrl: githubIssues.htmlUrl,
          state: githubIssues.state,
          ghCreatedAt: githubIssues.ghCreatedAt,
          closedAt: githubIssues.closedAt,
          assigneeGhIds: githubIssues.assigneeGhIds,
          closedByGhId: githubIssues.closedByGhId,
        })
        .from(githubIssues)
        .where(
          and(
            eq(githubIssues.orgId, input.orgId),
            isNotNull(githubIssues.closedAt),
            gte(githubIssues.closedAt, from),
            lte(githubIssues.closedAt, to),
          ),
        )
        .orderBy(desc(githubIssues.closedAt));

      const issues = issueRows
        .filter((r) => {
          const assignees = Array.isArray(r.assigneeGhIds)
            ? r.assigneeGhIds.filter(
                (v): v is number => typeof v === "number" && Number.isFinite(v),
              )
            : [];
          return r.closedByGhId === ghUserId || assignees.includes(ghUserId);
        })
        .slice(0, input.limit)
        .map((r) => ({
          repoFullName: r.repoFullName,
          number: r.number,
          title: r.title,
          htmlUrl: r.htmlUrl,
          state: r.state,
          ghCreatedAt: r.ghCreatedAt,
          closedAt: r.closedAt,
        }));

      const reviews = await ctx.db
        .select({
          repoFullName: githubReviews.repoFullName,
          prGhNodeId: githubReviews.prGhNodeId,
          state: githubReviews.state,
          submittedAt: githubReviews.submittedAt,
        })
        .from(githubReviews)
        .where(
          and(
            eq(githubReviews.orgId, input.orgId),
            eq(githubReviews.reviewerGhId, ghUserId),
            gte(githubReviews.submittedAt, from),
            lte(githubReviews.submittedAt, to),
          ),
        )
        .orderBy(desc(githubReviews.submittedAt))
        .limit(input.limit);

      return { ghUserId, pulls, issues, reviews };
    }),
});
