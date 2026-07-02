import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, isNotNull, isNull, lte, max, or } from "drizzle-orm";
import {
  apiKeys,
  evaluationReports,
  evaluationReportsByKey,
  gdprDeleteRequests,
  organizationMembers,
  requestBodies,
  rubrics,
  teamMembers,
  usageLogs,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import { can } from "@caliber/auth";
import { buildEvaluatorJobId } from "@caliber/evaluator";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";
import { notifyGdprRequested } from "../../services/gdprNotifications.js";
import { getFacetSummary } from "../../services/facetSummary.js";

// ─── Evaluator queue constants (duplicated from apps/gateway to avoid cross-package import) ──
// TODO: extract to a shared @caliber/queue package to eliminate this duplication.
// jobId derivation uses `buildEvaluatorJobId` (from @caliber/evaluator) — shared with
// apps/gateway enqueueEvaluator — so cron and admin-rerun always dedup correctly.
const EVALUATOR_QUEUE_NAME = "evaluator";
const EVALUATOR_QUEUE_PREFIX = "caliber:gw";

// Minimal Queue interface — matches the BullMQ Queue surface we need.
// When ctx.evaluatorQueue is undefined (test mode / queue not wired), rerun
// returns { enqueued: 0, targets: N, testMode: true } instead of calling add().
interface EvaluatorQueue {
  add(
    name: string,
    data: EvaluatorJobPayload,
    opts?: { jobId?: string },
  ): Promise<unknown>;
}

interface EvaluatorJobPayload {
  orgId: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  periodType: string;
  triggeredBy: string;
  triggeredByUser: string;
  // Per-key grain (PR5). MUST stay in lockstep with apps/gateway's
  // EvaluatorJobPayload (queue.ts): when `apiKeyId` is set the enqueue jobId
  // becomes the 4-part `${userId}:${apiKeyId}:${periodStart}:${periodType}`
  // and `keyNameSnapshot` is required/non-empty — see `rerun` below.
  apiKeyId?: string;
  keyNameSnapshot?: string;
}

export { EVALUATOR_QUEUE_NAME, EVALUATOR_QUEUE_PREFIX };
export type { EvaluatorQueue };

// ─── Input primitives ─────────────────────────────────────────────────────────

const dateRange = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// ─── LLM redaction ────────────────────────────────────────────────────────────

// The subset of LLM-derived columns that non-subject, non-admin viewers must
// not see. Shared by the per-person (`evaluation_reports`) and per-key
// (`evaluation_reports_by_key`) tables — both carry these exact nullable
// columns — so a single generic helper redacts either row shape identically.
interface LlmRedactable {
  llmNarrative: string | null;
  llmEvidence: unknown;
  llmModel: string | null;
  llmCalledAt: Date | null;
  llmCostUsd: string | null;
  llmUpstreamAccountId: string | null;
}

function redactLlm<T extends LlmRedactable>(row: T, canSeeLlm: boolean): T {
  if (canSeeLlm) return row;
  return {
    ...row,
    llmNarrative: null,
    llmEvidence: null,
    llmModel: null,
    llmCalledAt: null,
    llmCostUsd: null,
    llmUpstreamAccountId: null,
  };
}

// ─── Per-key ownership / tenancy guards (anti-enumeration) ──────────────────────

/**
 * Assert the api key exists and is owned by `userId`. Throws NOT_FOUND (never
 * FORBIDDEN) on a missing key OR a key owned by someone else, so an own-scope
 * reader cannot enumerate other users' keys. Used by `getOwnByKey*`.
 */
async function assertOwnApiKey(
  db: Database,
  apiKeyId: string,
  userId: string,
): Promise<void> {
  const [key] = await db
    .select({ ownerUserId: apiKeys.userId })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  if (!key || key.ownerUserId !== userId) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

/**
 * Resolve a key's owner within `orgId`. Throws NOT_FOUND when the key is
 * missing OR `key.orgId !== orgId` (cross-org anti-enumeration). Returns the
 * resolved owner + name + org for the caller to run its RBAC + jobId logic.
 */
async function resolveKeyInOrg(
  db: Database,
  apiKeyId: string,
  orgId: string,
): Promise<{ userId: string; orgId: string; name: string }> {
  const [key] = await db
    .select({
      userId: apiKeys.userId,
      orgId: apiKeys.orgId,
      name: apiKeys.name,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  if (!key || key.orgId !== orgId) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return key;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const reportsRouter = router({
  /**
   * Returns the caller's most recent evaluation report (by periodStart desc).
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnLatest: evaluatorProcedure.query(async ({ ctx }) => {
    if (!can(ctx.perm, { type: "report.read_own" })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const row = await ctx.db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, ctx.user.id))
      .orderBy(desc(evaluationReports.periodStart))
      .limit(1)
      .then((r) => r[0] ?? null);

    return row;
  }),

  /**
   * Returns all of the caller's reports whose periodStart falls within [from, to].
   * Results are ordered by periodStart desc.
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnRange: evaluatorProcedure
    .input(dateRange)
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.userId, ctx.user.id),
            gte(evaluationReports.periodStart, new Date(input.from)),
            lte(evaluationReports.periodStart, new Date(input.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      return rows;
    }),

  /**
   * Returns a specific user's reports within the given date range.
   * LLM fields are visible only to the report subject or an org_admin.
   * Requires `report.read_user` — granted when:
   *   - targetUserId === caller's own id (self-access), OR
   *   - caller is org_admin for the org.
   */
  getUser: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        userId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.userId, input.userId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      const canSeeLlm =
        input.userId === ctx.user.id ||
        can(ctx.perm, { type: "report.read_org", orgId: input.orgId });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns the facet-extraction aggregate for one (org, user, period) window.
   * Surfaces session-type distribution, success rate, and the four
   * count-style metrics that the rule-engine signals consume. Used by the
   * report-page drill-down (Plan 4C follow-up #3).
   *
   * Same RBAC as `getUser`: `report.read_user`. Returns the empty summary
   * (zero rows, all null aggregates) when no facet rows exist for the
   * window — never throws on empty input.
   */
  facetSummary: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        userId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      return getFacetSummary(
        ctx.db,
        input.orgId,
        input.userId,
        new Date(input.range.from),
        new Date(input.range.to),
      );
    }),

  /**
   * Returns aggregate-level team reports within the given date range.
   * LLM fields are visible only to org_admins; team_managers see them redacted.
   * Requires `report.read_team` — granted when caller is team_manager or org_admin.
   */
  getTeam: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        teamId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_team",
          orgId: input.orgId,
          teamId: input.teamId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.teamId, input.teamId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Only org_admins see LLM details — team_managers get them redacted.
      const canSeeLlm = can(ctx.perm, {
        type: "report.read_org",
        orgId: input.orgId,
      });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns all org-wide reports within the given date range.
   * Caller must be org_admin (report.read_org), and therefore always sees
   * full LLM fields — no redaction applied at this scope.
   */
  getOrg: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_org", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Caller is org_admin (enforced above) — full LLM fields returned.
      return rows;
    }),

  // ─── Per-key (project) report reads ───────────────────────────────────────────

  /**
   * Latest per-key (project) report for one of the CALLER's OWN api keys.
   * Mirrors `getOwnLatest` but scoped to a single api_key.
   *
   * Anti-enumeration: asserts `api_keys.userId === ctx.user.id` and returns
   * NOT_FOUND when the key is missing or owned by someone else — never leaks
   * the key's existence. The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnByKeyLatest: evaluatorProcedure
    .input(z.object({ apiKeyId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      await assertOwnApiKey(ctx.db, input.apiKeyId, ctx.user.id);

      const row = await ctx.db
        .select()
        .from(evaluationReportsByKey)
        .where(
          and(
            eq(evaluationReportsByKey.apiKeyId, input.apiKeyId),
            eq(evaluationReportsByKey.userId, ctx.user.id),
          ),
        )
        .orderBy(desc(evaluationReportsByKey.periodStart))
        .limit(1)
        .then((r) => r[0] ?? null);

      return row;
    }),

  /**
   * All per-key reports for one of the CALLER's OWN api keys whose periodStart
   * is within [from, to], ordered periodStart desc. Mirrors `getOwnRange`.
   * Same anti-enumeration ownership assert as `getOwnByKeyLatest`.
   * Requires `report.read_own`.
   */
  getOwnByKeyRange: evaluatorProcedure
    .input(z.object({ apiKeyId: z.string().uuid() }).merge(dateRange))
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      await assertOwnApiKey(ctx.db, input.apiKeyId, ctx.user.id);

      const rows = await ctx.db
        .select()
        .from(evaluationReportsByKey)
        .where(
          and(
            eq(evaluationReportsByKey.apiKeyId, input.apiKeyId),
            eq(evaluationReportsByKey.userId, ctx.user.id),
            gte(evaluationReportsByKey.periodStart, new Date(input.from)),
            lte(evaluationReportsByKey.periodStart, new Date(input.to)),
          ),
        )
        .orderBy(desc(evaluationReportsByKey.periodStart));

      return rows;
    }),

  /**
   * Per-key reports for a specific api key, for admins / the subject. Mirrors
   * `getUser` (per-user read): gate `report.read_user`, LLM visible only to the
   * subject or an org_admin (redacted otherwise via the shared `redactLlm`).
   *
   * Anti-enumeration: resolves the key's owner + org; if the key is missing or
   * `key.orgId !== input.orgId`, returns NOT_FOUND so cross-org probes can't
   * confirm a key's existence.
   */
  getByKey: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        apiKeyId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      const key = await resolveKeyInOrg(ctx.db, input.apiKeyId, input.orgId);

      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: key.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReportsByKey)
        .where(
          and(
            eq(evaluationReportsByKey.orgId, input.orgId),
            eq(evaluationReportsByKey.apiKeyId, input.apiKeyId),
            gte(evaluationReportsByKey.periodStart, new Date(input.range.from)),
            lte(evaluationReportsByKey.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReportsByKey.periodStart));

      // LLM visible only to the report subject or an org_admin — matches
      // `getUser`. (As with `getUser`, the only non-subject caller that passes
      // the `report.read_user` gate is an org_admin, who is also canSeeLlm; the
      // redaction is kept for parity and defence-in-depth.)
      const canSeeLlm =
        key.userId === ctx.user.id ||
        can(ctx.perm, { type: "report.read_org", orgId: input.orgId });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Opted-in ("score as project") api keys, with each key's latest report
   * periodStart, to drive UI selectors.
   *
   * - With `orgId`: org-wide listing — requires `report.read_org` (org_admin).
   * - Without `orgId`: the caller's OWN opted-in keys (`report.read_own`).
   * Revoked keys are excluded (cron no longer scores them; history is read via
   * the by-key read procedures using `key_name_snapshot`).
   */
  listProjectKeys: evaluatorProcedure
    .input(z.object({ orgId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      if (input.orgId) {
        if (!can(ctx.perm, { type: "report.read_org", orgId: input.orgId })) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
      } else if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const latest = ctx.db
        .select({
          apiKeyId: evaluationReportsByKey.apiKeyId,
          latestPeriodStart: max(evaluationReportsByKey.periodStart).as(
            "latest_period_start",
          ),
        })
        .from(evaluationReportsByKey)
        .groupBy(evaluationReportsByKey.apiKeyId)
        .as("latest");

      const scopeFilter = input.orgId
        ? eq(apiKeys.orgId, input.orgId)
        : eq(apiKeys.userId, ctx.user.id);

      const rows = await ctx.db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          userId: apiKeys.userId,
          teamId: apiKeys.teamId,
          latestPeriodStart: latest.latestPeriodStart,
          // Null for active keys; set for revoked-but-scored keys so the client
          // can render them read-only using key_name_snapshot history.
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .leftJoin(latest, eq(latest.apiKeyId, apiKeys.id))
        .where(
          and(
            eq(apiKeys.evaluateAsProject, true),
            scopeFilter,
            // Include active keys (revokedAt IS NULL) OR revoked keys that have
            // at least one by-key report (latestPeriodStart IS NOT NULL).
            // Revoked keys with no report history are omitted — they were never
            // scored and have no historical data to show read-only.
            or(isNull(apiKeys.revokedAt), isNotNull(latest.latestPeriodStart)),
          ),
        )
        .orderBy(apiKeys.name);

      return rows;
    }),

  // ─── Mutation endpoints ───────────────────────────────────────────────────────

  /**
   * Enqueue evaluator jobs for the given scope (user/team/org/key).
   * Window ≤ 30 days enforced. RBAC: `report.rerun` (org_admin).
   *
   * `scope: "key"` is the bounded on-demand per-key (project) backfill: it
   * requires `apiKeyId`, resolves the key's owner within `orgId` (NOT_FOUND on
   * a missing/cross-org key — anti-enumeration), and enqueues ONE per-key job.
   *
   * Production queue wiring is deferred to Task 6.4b. When ctx.evaluatorQueue
   * is undefined (test mode / not yet wired), returns { enqueued: 0, targets: N,
   * testMode: true } without calling BullMQ.
   */
  rerun: evaluatorProcedure
    .input(
      z
        .object({
          orgId: z.string().uuid(),
          scope: z.enum(["user", "team", "org", "key"]),
          // Required for user/team/org scopes (the target user/team/org id).
          // Unused for `key` scope, where `apiKeyId` is the target instead.
          targetId: z.string().uuid().optional(),
          // Required for `key` scope (the api_key to backfill).
          apiKeyId: z.string().uuid().optional(),
          periodStart: z.string().datetime(),
          periodEnd: z.string().datetime(),
        })
        .refine((d) => (d.scope === "key" ? !!d.apiKeyId : !!d.targetId), {
          message:
            "key scope requires apiKeyId; user/team/org scope requires targetId",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const startMs = new Date(input.periodStart).getTime();
      const endMs = new Date(input.periodEnd).getTime();
      const WINDOW_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

      if (endMs <= startMs) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "periodEnd must be after periodStart",
        });
      }
      if (endMs - startMs > WINDOW_LIMIT_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Window exceeds 30 days",
        });
      }

      // A rerun target: a user, optionally narrowed to a single api_key (the
      // per-key grain). `apiKeyId` present → 4-part jobId + per-key payload.
      interface RerunTarget {
        userId: string;
        apiKeyId?: string;
        keyNameSnapshot?: string;
      }
      const targets: RerunTarget[] = [];

      if (input.scope === "key") {
        // refine guarantees apiKeyId; narrow for TS.
        const apiKeyId = input.apiKeyId!;
        // Resolve owner + name within the org. NOT_FOUND (anti-enumeration)
        // when the key is missing or belongs to another org — runs BEFORE the
        // RBAC check so a cross-org probe can't tell FORBIDDEN from absent.
        const key = await resolveKeyInOrg(ctx.db, apiKeyId, input.orgId);
        if (
          !can(ctx.perm, {
            type: "report.rerun",
            orgId: input.orgId,
            targetUserId: key.userId,
            periodStart: input.periodStart,
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        targets.push({
          userId: key.userId,
          apiKeyId,
          keyNameSnapshot: key.name,
        });
      } else if (input.scope === "user") {
        const targetId = input.targetId!;
        if (
          !can(ctx.perm, {
            type: "report.rerun",
            orgId: input.orgId,
            targetUserId: targetId,
            periodStart: input.periodStart,
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        targets.push({ userId: targetId });
      } else {
        // team/org scope reuses the org_admin gate.
        if (
          !can(ctx.perm, {
            type: "report.rerun",
            orgId: input.orgId,
            targetUserId: ctx.user.id,
            periodStart: input.periodStart,
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        if (input.scope === "team") {
          const members = await ctx.db
            .select({ userId: teamMembers.userId })
            .from(teamMembers)
            .where(eq(teamMembers.teamId, input.targetId!));
          targets.push(...members.map((m) => ({ userId: m.userId })));
        } else {
          const members = await ctx.db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(eq(organizationMembers.orgId, input.orgId));
          targets.push(...members.map((m) => ({ userId: m.userId })));
        }
      }

      // ctx.evaluatorQueue is undefined when ENABLE_EVALUATOR=false or no
      // REDIS_URL is configured (e.g. test mode). Falls back gracefully.
      const queue = ctx.evaluatorQueue;

      if (!queue) {
        return {
          enqueued: 0,
          targets: targets.length,
          testMode: true as const,
        };
      }

      let enqueued = 0;
      for (const target of targets) {
        try {
          // jobId uses the shared buildEvaluatorJobId (from @caliber/evaluator),
          // which also powers apps/gateway enqueueEvaluator. Same inputs →
          // same id on both sides → cron and admin-rerun dedup correctly.
          const jobId = buildEvaluatorJobId({
            userId: target.userId,
            apiKeyId: target.apiKeyId,
            periodStart: input.periodStart,
            periodType: "daily",
          });
          const payload: EvaluatorJobPayload = {
            orgId: input.orgId,
            userId: target.userId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            periodType: "daily",
            triggeredBy: "admin_rerun",
            triggeredByUser: ctx.user.id,
            ...(target.apiKeyId
              ? {
                  apiKeyId: target.apiKeyId,
                  keyNameSnapshot: target.keyNameSnapshot,
                }
              : {}),
          };
          await queue.add(EVALUATOR_QUEUE_NAME, payload, { jobId });
          enqueued += 1;
        } catch {
          // Dedup collision — expected, not an error
        }
      }

      return { enqueued, targets: targets.length, testMode: false as const };
    }),

  /**
   * Generate a JSON dump of the caller's data (reports + body metadata).
   * Bodies are listed by requestId only — no decrypted content, since the api
   * server does not hold CREDENTIAL_ENCRYPTION_KEY in all environments.
   * Satisfies GDPR "right to access" without cross-cutting crypto.
   * Requires `report.export_own` (always-true for authenticated users).
   */
  exportOwn: evaluatorProcedure.query(async ({ ctx }) => {
    if (!can(ctx.perm, { type: "report.export_own" })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const reports = await ctx.db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, ctx.user.id))
      .orderBy(desc(evaluationReports.periodStart));

    // GDPR access/portability: per-key (project) reports are the caller's own
    // data too — include them so the export is complete. Owner sees full LLM.
    const reportsByKey = await ctx.db
      .select()
      .from(evaluationReportsByKey)
      .where(eq(evaluationReportsByKey.userId, ctx.user.id))
      .orderBy(desc(evaluationReportsByKey.periodStart));

    // List body request metadata only — NOT decrypted body content
    const bodies = await ctx.db
      .select({
        requestId: requestBodies.requestId,
        capturedAt: requestBodies.capturedAt,
        retentionUntil: requestBodies.retentionUntil,
        bodyTruncated: requestBodies.bodyTruncated,
        toolResultTruncated: requestBodies.toolResultTruncated,
      })
      .from(requestBodies)
      .innerJoin(usageLogs, eq(usageLogs.requestId, requestBodies.requestId))
      .where(eq(usageLogs.userId, ctx.user.id));

    // GDPR Art. 15/20 portability: include key rubrics authored by this user.
    // Selection: created_by = caller AND api_key_id IS NOT NULL (key-scoped)
    // AND deleted_at IS NULL (live rubrics only).
    //
    // Erasure semantics (bodies_and_reports soft-erasure): key rubrics are
    // PROJECT SCORING CONFIG, not personal content. They are KEPT on
    // soft-erasure (consistent with org rubrics). The author link (createdBy)
    // anonymizes via ON DELETE SET NULL only on eventual full user hard-delete.
    // Do NOT add key rubrics to the soft-erasure deletion set.
    const keyRubrics = await ctx.db
      .select({
        id: rubrics.id,
        apiKeyId: rubrics.apiKeyId,
        name: rubrics.name,
        version: rubrics.version,
        definition: rubrics.definition,
        createdAt: rubrics.createdAt,
      })
      .from(rubrics)
      .where(
        and(
          eq(rubrics.createdBy, ctx.user.id),
          isNotNull(rubrics.apiKeyId),
          isNull(rubrics.deletedAt),
        ),
      );

    return {
      userId: ctx.user.id,
      exportedAt: new Date(),
      reports,
      reportsByKey,
      bodies,
      keyRubrics,
      note: "Body content is encrypted at rest. Contact your administrator to request decrypted exports.",
    };
  }),

  /**
   * Insert a pending GDPR delete request (requires admin approval to execute).
   * scope: "bodies" deletes request bodies only; "bodies_and_reports" also
   * removes evaluation reports. Requires `report.delete_own` (always-true).
   * Emits a structured log + audit log for observability and compliance.
   */
  deleteOwn: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        scope: z.enum(["bodies", "bodies_and_reports"]),
        reason: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.delete_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [created] = await ctx.db
        .insert(gdprDeleteRequests)
        .values({
          orgId: input.orgId,
          userId: ctx.user.id,
          requestedByUserId: ctx.user.id,
          reason: input.reason ?? null,
          scope: input.scope,
        })
        .returning({ id: gdprDeleteRequests.id });

      // Emit structured log + audit log for observability and compliance
      await notifyGdprRequested({
        db: ctx.db,
        orgId: input.orgId,
        userId: ctx.user.id,
        requestedByUserId: ctx.user.id,
        requestId: created!.id,
        scope: input.scope,
        reason: input.reason ?? null,
        logger: ctx.logger,
      });

      return { id: created!.id };
    }),

  /**
   * Approve a pending GDPR delete request.
   * Sets approvedAt + approvedByUserId. Actual data deletion is performed by a
   * background worker that polls for approved requests (out of scope here).
   * RBAC: reuses `report.rerun` as the org_admin gate (no dedicated action yet).
   */
  approveDelete: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        requestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.rerun",
          orgId: input.orgId,
          targetUserId: ctx.user.id,
          periodStart: "1970-01-01",
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(gdprDeleteRequests)
        .set({
          approvedAt: new Date(),
          approvedByUserId: ctx.user.id,
        })
        .where(
          and(
            eq(gdprDeleteRequests.id, input.requestId),
            eq(gdprDeleteRequests.orgId, input.orgId),
          ),
        );

      return { success: true };
    }),

  /**
   * Reject a pending GDPR delete request with a mandatory reason.
   * Sets rejectedAt + rejectedReason. Same org_admin RBAC as approveDelete.
   */
  rejectDelete: evaluatorProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        requestId: z.string().uuid(),
        reason: z.string().max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.rerun",
          orgId: input.orgId,
          targetUserId: ctx.user.id,
          periodStart: "1970-01-01",
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(gdprDeleteRequests)
        .set({
          rejectedAt: new Date(),
          rejectedReason: input.reason,
        })
        .where(
          and(
            eq(gdprDeleteRequests.id, input.requestId),
            eq(gdprDeleteRequests.orgId, input.orgId),
          ),
        );

      return { success: true };
    }),
});
