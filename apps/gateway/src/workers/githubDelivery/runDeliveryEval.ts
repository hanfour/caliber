/**
 * One delivery evaluation (PR2, spec Component 3): staleness-gated inline
 * sync → attribution → pure metrics/score → report upsert. Sync failures
 * degrade to scoring existing data (the report always lands). llm_status
 * is 'skipped' until PR3 adds the quality layer.
 */
import { eq } from "drizzle-orm";
import { githubConnections, githubDeliveryReports } from "@caliber/db";
import type { Database } from "@caliber/db";
import { computeDeliveryMetrics, scoreDelivery } from "@caliber/evaluator";
import { syncOrg } from "../githubSync/syncOrg.js";
import { fetchDeliveryActivity, resolveGithubUserId } from "./fetchActivity.js";
import type { GithubDeliveryJobPayload } from "./queue.js";

export const SYNC_STALE_AFTER_MS = 60 * 60 * 1000;

export interface RunDeliveryEvalResult {
  reportId: string | null;
  skippedSync: boolean;
  noIdentity: boolean;
}

export async function runDeliveryEval(input: {
  db: Database;
  masterKeyHex: string;
  payload: GithubDeliveryJobPayload;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<RunDeliveryEvalResult> {
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
      });
    } catch {
      // Sync is best-effort here; score whatever data exists.
    }
  }

  const ghUserId = await resolveGithubUserId(db, payload.userId);

  const upsert = async (fields: {
    totalScore: string | null;
    insufficientData: boolean;
    sectionScores: unknown;
    metrics: unknown;
  }): Promise<string | null> => {
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
        llmStatus: "skipped",
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
          llmStatus: "skipped",
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

  const reportId = await upsert({
    totalScore: score.totalScore === null ? null : score.totalScore.toString(),
    insufficientData: score.insufficientData,
    sectionScores: score.sections,
    metrics: {
      windowDays: score.windowDays,
      totalEvents: score.totalEvents,
      values: metrics.values,
      rubricVersion: score.rubricVersion,
    },
  });
  return { reportId, skippedSync: !syncNeeded, noIdentity: false };
}
