/**
 * One delivery evaluation (PR2, spec Component 3) + LLM quality merge
 * (PR3 Task 6): staleness-gated inline sync → attribution → pure
 * metrics/score → report upsert → (when scorable) LLM quality-adjustment
 * merge. Sync failures degrade to scoring existing data (the report
 * always lands).
 *
 * Two-phase upsert for the LLM half: the quant-only report is upserted
 * FIRST (`llm_status: "skipped"` placeholder) so `runDeliveryQuality` has
 * a real `reportId` to ledger spend against before it ever calls the LLM
 * (its ledger dedup index is keyed on `refId`, chicken-and-egg with the
 * row it references). Only a non-`"skipped"` quality outcome triggers a
 * second upsert (identical conflict target — an UPDATE in practice) that
 * overlays the `llm_*` fields onto that same row. A `"skipped"` quality
 * outcome (org disabled/no model/no connection/no merged PRs) leaves the
 * phase-1 placeholder exactly as it landed — today's behavior, unchanged.
 *
 * Transport errors from `runDeliveryQuality` (loopback fetch failure,
 * missing eval key, non-2xx upstream) are NOT caught here — they
 * propagate so BullMQ retries the whole job. The quant row already
 * persisted in phase 1, so a retry's phase-1 upsert is an idempotent
 * no-op update (same conflict target, same values).
 */
import { eq } from "drizzle-orm";
import { githubConnections, githubDeliveryReports } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import {
  computeDeliveryMetrics,
  deepStripInvalidJsonbChars,
  scoreDelivery,
} from "@caliber/evaluator";
import { safeErrorMessage } from "@caliber/gateway-core";
import { syncOrg } from "../githubSync/syncOrg.js";
import { fetchDeliveryActivity, resolveGithubUserId } from "./fetchActivity.js";
import { runDeliveryQuality } from "./runDeliveryQuality.js";
import type { GithubDeliveryJobPayload } from "./queue.js";

export const SYNC_STALE_AFTER_MS = 60 * 60 * 1000;

/** `totalScore` is clamped into this range after the LLM adjustment. */
const TOTAL_SCORE_MIN = 0;
const TOTAL_SCORE_MAX = 120;

/** Mirrors weeklyCron.ts's LoggerLike — kept as a separate declaration since
 * apps/gateway has no shared logger-types module (same precedent as the
 * queue-constant duplication in apps/api's githubDelivery.ts). */
export interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface RunDeliveryEvalResult {
  reportId: string | null;
  skippedSync: boolean;
  noIdentity: boolean;
}

export interface RunDeliveryEvalInput {
  db: Database;
  masterKeyHex: string;
  payload: GithubDeliveryJobPayload;
  /** Required — the quality layer's loopback LLM key lookup needs a real
   * (un-prefixed) redis client; the worker always has one (same instance
   * it uses for its BullMQ connection). */
  redis: Redis;
  /** Required — base URL the quality layer's loopback /v1/messages call
   * targets. */
  gatewayBaseUrl: string;
  /** Test seam; threaded to the staleness-gated inline sync AND the
   * quality layer's GitHub/LLM-loopback fetches. */
  fetchImpl?: typeof fetch;
  now?: Date;
  logger?: LoggerLike;
}

/** Round to 1dp and clamp into [0, 120], stringified for the decimal column. */
function clampTotalScore(value: number): string {
  const clamped = Math.min(TOTAL_SCORE_MAX, Math.max(TOTAL_SCORE_MIN, value));
  return (Math.round(clamped * 10) / 10).toString();
}

export async function runDeliveryEval(
  input: RunDeliveryEvalInput,
): Promise<RunDeliveryEvalResult> {
  const { db, payload } = input;
  const now = input.now ?? new Date();
  const window = {
    start: new Date(payload.periodStart),
    end: new Date(payload.periodEnd),
  };

  const conn = (
    await db
      .select({
        deliveryEnabled: githubConnections.deliveryEnabled,
        lastSyncAt: githubConnections.lastSyncAt,
      })
      .from(githubConnections)
      .where(eq(githubConnections.orgId, payload.orgId))
      .limit(1)
  )[0];

  const syncNeeded =
    conn !== undefined &&
    conn.deliveryEnabled &&
    (conn.lastSyncAt === null ||
      now.getTime() - conn.lastSyncAt.getTime() > SYNC_STALE_AFTER_MS);

  if (syncNeeded) {
    try {
      await syncOrg({
        db,
        masterKeyHex: input.masterKeyHex,
        orgId: payload.orgId,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
      });
    } catch (err) {
      // Sync is best-effort here; score whatever data exists. Still worth a
      // trace — a throw before syncOrg's own try/catch takes over (e.g. a
      // decrypt failure on the sealed PAT) would otherwise leave zero
      // record that the inline sync never ran.
      input.logger?.warn(
        { err: safeErrorMessage(err), orgId: payload.orgId },
        "github-delivery inline sync failed; scoring existing data",
      );
    }
  }

  const ghUserId = await resolveGithubUserId(db, payload.userId);

  const upsert = async (fields: {
    totalScore: string | null;
    insufficientData: boolean;
    sectionScores: unknown;
    metrics: unknown;
    llmStatus?: string;
    llmQualityAdjustment?: string | null;
    llmNarrative?: string | null;
    llmEvidence?: unknown;
    llmModel?: string | null;
    llmCalledAt?: Date | null;
    llmCostUsd?: string | null;
  }): Promise<string | null> => {
    const llmStatus = fields.llmStatus ?? "skipped";
    const llmQualityAdjustment = fields.llmQualityAdjustment ?? null;
    const llmNarrative = fields.llmNarrative ?? null;
    const llmEvidence = fields.llmEvidence ?? null;
    const llmModel = fields.llmModel ?? null;
    const llmCalledAt = fields.llmCalledAt ?? null;
    const llmCostUsd = fields.llmCostUsd ?? null;

    const [row] = await db
      .insert(githubDeliveryReports)
      .values({
        orgId: payload.orgId,
        userId: payload.userId,
        periodStart: window.start,
        periodEnd: window.end,
        periodType: payload.periodType,
        totalScore: fields.totalScore,
        insufficientData: fields.insufficientData,
        sectionScores: fields.sectionScores,
        metrics: fields.metrics,
        llmStatus,
        llmQualityAdjustment,
        llmNarrative,
        llmEvidence,
        llmModel,
        llmCalledAt,
        llmCostUsd,
        triggeredBy: payload.triggeredBy,
      })
      .onConflictDoUpdate({
        target: [
          githubDeliveryReports.orgId,
          githubDeliveryReports.userId,
          githubDeliveryReports.periodStart,
          githubDeliveryReports.periodType,
        ],
        set: {
          periodEnd: window.end,
          totalScore: fields.totalScore,
          insufficientData: fields.insufficientData,
          sectionScores: fields.sectionScores,
          metrics: fields.metrics,
          llmStatus,
          llmQualityAdjustment,
          llmNarrative,
          llmEvidence,
          llmModel,
          llmCalledAt,
          llmCostUsd,
          triggeredBy: payload.triggeredBy,
          updatedAt: new Date(),
        },
      })
      .returning({ id: githubDeliveryReports.id });
    return row?.id ?? null;
  };

  if (ghUserId === null) {
    const reportId = await upsert({
      totalScore: null,
      insufficientData: true,
      sectionScores: [],
      metrics: { noIdentity: true },
    });
    return { reportId, skippedSync: !syncNeeded, noIdentity: true };
  }

  const activity = await fetchDeliveryActivity(db, {
    orgId: payload.orgId,
    ghUserId,
    window,
  });
  const metrics = computeDeliveryMetrics({ ghUserId, window, ...activity });
  const score = scoreDelivery(metrics);
  const quantTotal = score.totalScore;

  const quantFields = {
    totalScore: quantTotal === null ? null : quantTotal.toString(),
    insufficientData: score.insufficientData,
    sectionScores: score.sections,
    metrics: {
      windowDays: score.windowDays,
      totalEvents: score.totalEvents,
      values: metrics.values,
      rubricVersion: score.rubricVersion,
    },
  };

  // Phase 1: quant-only upsert. Always lands, even when the LLM half never
  // runs — this IS today's report for the noIdentity/insufficient-data
  // cases, and the ledger-target placeholder otherwise.
  const reportId = await upsert(quantFields);

  // No quality call when the quant score itself is unusable (or the
  // placeholder insert somehow failed to return an id) — matches today's
  // `llm_status: "skipped"` exactly, with no llm columns touched.
  if (score.insufficientData || quantTotal === null || reportId === null) {
    return { reportId, skippedSync: !syncNeeded, noIdentity: false };
  }

  const quality = await runDeliveryQuality({
    db,
    redis: input.redis,
    gatewayBaseUrl: input.gatewayBaseUrl,
    masterKeyHex: input.masterKeyHex,
    orgId: payload.orgId,
    ghUserId,
    reportId,
    window,
    quant: {
      totalScore: quantTotal,
      windowDays: score.windowDays,
      sections: score.sections.map((s) => ({ key: s.key, score: s.score })),
    },
    fetchImpl: input.fetchImpl,
    logger: input.logger,
  });

  if (quality.status === "skipped") {
    // Phase-1 placeholder is already correct — nothing to overlay.
    return { reportId, skippedSync: !syncNeeded, noIdentity: false };
  }

  if (quality.status === "ok") {
    await upsert({
      ...quantFields,
      totalScore: clampTotalScore(quantTotal + quality.qualityAdjustment),
      llmStatus: "ok",
      llmQualityAdjustment: quality.qualityAdjustment.toString(),
      // deepStrip guards the jsonb write boundary: a lone UTF-16 surrogate /
      // NUL in LLM-generated free text would otherwise fail the whole report
      // upsert with "invalid input syntax for type json" — same fix as
      // runRuleBased.ts / upsertEvaluationReportByKey.ts (v0.27.1 crash class).
      llmNarrative: deepStripInvalidJsonbChars(quality.narrative),
      llmEvidence: deepStripInvalidJsonbChars(quality.evidence) as unknown,
      llmModel: quality.model,
      llmCalledAt: quality.calledAt,
      llmCostUsd: quality.costUsd === null ? null : quality.costUsd.toString(),
    });
  } else if (quality.status === "parse_error") {
    await upsert({
      ...quantFields,
      llmStatus: "parse_error",
      llmModel: quality.model,
    });
  } else {
    // budget_denied — llm columns stay null besides the status itself.
    await upsert({
      ...quantFields,
      llmStatus: "budget_denied",
    });
  }

  return { reportId, skippedSync: !syncNeeded, noIdentity: false };
}
