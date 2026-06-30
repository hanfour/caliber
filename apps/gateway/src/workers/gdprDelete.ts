/**
 * GDPR delete worker (Plan 4B Part 10, Task 10.1; Phase 1 multi-source ingest
 * cascade extension 2026-05).
 *
 * Runs every 5 minutes. For each approved (but not yet executed) GDPR delete
 * request:
 *   1. Delete request_bodies rows for the user via a subquery join to usage_logs
 *      (request_bodies.request_id FK → usage_logs.request_id; user's bodies are
 *      all those tied to the user's usage rows within the org).
 *   2. Delete client_sessions rows for (org_id, user_id) — cascades to
 *      client_events via FK ON DELETE CASCADE. Event count is captured before
 *      delete for audit visibility.
 *   3. If scope="bodies_and_reports", also delete evaluation_reports AND
 *      evaluation_reports_by_key for the user. (The per-key table's
 *      api_key_id ON DELETE CASCADE only fires on key HARD-delete, never on
 *      this soft-delete erasure path, so we must delete the rows explicitly.)
 *   4. Mark the request as executed (executedAt = now()).
 *   5. Write an audit log entry proving the deletion happened.
 *
 * Design notes:
 *   - Gate: approvedAt IS NOT NULL AND executedAt IS NULL AND rejectedAt IS NULL
 *     prevents re-processing executed requests and skips rejected ones.
 *   - Raw SQL for the bodies delete (subquery join) because Drizzle's typed
 *     DELETE…WHERE…IN doesn't support subqueries that reference a second table.
 *   - client_sessions cascade ALWAYS runs, regardless of scope: the spec moves
 *     this cascade to Phase 1 (not Phase 4) so first-day transcript ingest is
 *     deletable. The `bodies_and_reports` scope only widens to evaluation_reports.
 *   - Each request is processed independently; a failure on one request
 *     increments `failures` and continues — partial progress is observable via
 *     the audit log (only executed requests have an entry).
 *   - intervalMs is injectable for tests so callers don't need to wait 5 min.
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  gdprDeleteRequests,
  evaluationReports,
  evaluationReportsByKey,
  clientSessions,
  auditLogs,
} from "@caliber/db";

export const GDPR_DELETE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Core function ─────────────────────────────────────────────────────────────

export interface ExecuteGdprDeletionsInput {
  db: Database;
  /** Override for tests to control "now" without real timers. */
  now?: () => Date;
}

export interface ExecuteGdprDeletionsResult {
  requestsProcessed: number;
  bodiesDeleted: number;
  reportsDeleted: number;
  reportsByKeyDeleted: number;
  clientSessionsDeleted: number;
  clientEventsDeleted: number;
  failures: number;
}

/**
 * Find approved GDPR requests and execute them.
 *
 * Returns aggregate counts across all processed requests. Failures are counted
 * but not thrown — each request is independent.
 */
export async function executeGdprDeletions(
  input: ExecuteGdprDeletionsInput,
): Promise<ExecuteGdprDeletionsResult> {
  const { db, now = () => new Date() } = input;

  const approved = await db
    .select()
    .from(gdprDeleteRequests)
    .where(
      and(
        isNotNull(gdprDeleteRequests.approvedAt),
        isNull(gdprDeleteRequests.executedAt),
        isNull(gdprDeleteRequests.rejectedAt),
      ),
    );

  let bodiesDeleted = 0;
  let reportsDeleted = 0;
  let reportsByKeyDeleted = 0;
  let clientSessionsDeleted = 0;
  let clientEventsDeleted = 0;
  let failures = 0;

  for (const request of approved) {
    try {
      // Delete request_bodies for this user via subquery join to usage_logs.
      // Drizzle's typed DELETE doesn't support multi-table subqueries, so we
      // use raw SQL (safe: all values are uuid params, no interpolation risk).
      const bodiesResult = await db.execute(sql`
        DELETE FROM request_bodies
        WHERE request_id IN (
          SELECT request_id FROM usage_logs
          WHERE user_id = ${request.userId}
            AND org_id = ${request.orgId}
        )
        AND org_id = ${request.orgId}
      `);
      const bodiesDeletedHere =
        (bodiesResult as { rowCount: number | null }).rowCount ?? 0;
      bodiesDeleted += bodiesDeletedHere;

      // Cascade-count client_events first so the audit log records the volume
      // before the rows are gone. The FK on client_events.session_id has
      // ON DELETE CASCADE, so DELETE FROM client_sessions removes both.
      const eventCountRow = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM client_events ce
        JOIN client_sessions cs ON cs.id = ce.session_id
        WHERE cs.user_id = ${request.userId}
          AND cs.org_id = ${request.orgId}
      `);
      const eventsThisReq = eventCountRow.rows[0]?.count ?? 0;

      const sessionsResult = await db
        .delete(clientSessions)
        .where(
          and(
            eq(clientSessions.userId, request.userId),
            eq(clientSessions.orgId, request.orgId),
          ),
        );
      const sessionsThisReq =
        (sessionsResult as { rowCount: number | null }).rowCount ?? 0;
      clientSessionsDeleted += sessionsThisReq;
      clientEventsDeleted += eventsThisReq;

      // Optionally delete evaluation reports (per-person AND per-key).
      let reportsThisReq = 0;
      let reportsByKeyThisReq = 0;
      if (request.scope === "bodies_and_reports") {
        const reportsResult = await db
          .delete(evaluationReports)
          .where(
            and(
              eq(evaluationReports.userId, request.userId),
              eq(evaluationReports.orgId, request.orgId),
            ),
          );
        reportsThisReq =
          (reportsResult as { rowCount: number | null }).rowCount ?? 0;
        reportsDeleted += reportsThisReq;

        // Per-key reports: the api_key_id ON DELETE CASCADE only fires on key
        // HARD-delete, not this soft-delete erasure path, so delete by
        // (user_id, org_id) explicitly — otherwise the user_id ON DELETE
        // RESTRICT FK would block a later user hard-delete.
        const byKeyResult = await db
          .delete(evaluationReportsByKey)
          .where(
            and(
              eq(evaluationReportsByKey.userId, request.userId),
              eq(evaluationReportsByKey.orgId, request.orgId),
            ),
          );
        reportsByKeyThisReq =
          (byKeyResult as { rowCount: number | null }).rowCount ?? 0;
        reportsByKeyDeleted += reportsByKeyThisReq;
      }

      // Mark request executed.
      await db
        .update(gdprDeleteRequests)
        .set({ executedAt: now() })
        .where(eq(gdprDeleteRequests.id, request.id));

      // Write audit log entry — compliance proof that the deletion occurred.
      // Per-request counts (not running totals) so each audit entry stands
      // alone when reviewed independently.
      await db.insert(auditLogs).values({
        orgId: request.orgId,
        actorUserId: request.approvedByUserId,
        action: "gdpr.delete_executed",
        targetType: "user",
        targetId: request.userId,
        metadata: {
          requestId: request.id,
          scope: request.scope,
          bodiesDeleted: bodiesDeletedHere,
          reportsDeleted: reportsThisReq,
          reportsByKeyDeleted: reportsByKeyThisReq,
          clientSessionsDeleted: sessionsThisReq,
          clientEventsDeleted: eventsThisReq,
        },
      });
    } catch {
      failures += 1;
    }
  }

  return {
    requestsProcessed: approved.length,
    bodiesDeleted,
    reportsDeleted,
    reportsByKeyDeleted,
    clientSessionsDeleted,
    clientEventsDeleted,
    failures,
  };
}

// ── Cron ─────────────────────────────────────────────────────────────────────

export interface GdprDeleteCronMetrics {
  executedTotal?: { inc: (n: number) => void };
  bodiesDeletedTotal?: { inc: (n: number) => void };
  reportsDeletedTotal?: { inc: (n: number) => void };
  reportsByKeyDeletedTotal?: { inc: (n: number) => void };
  clientSessionsDeletedTotal?: { inc: (n: number) => void };
  clientEventsDeletedTotal?: { inc: (n: number) => void };
  failuresTotal?: { inc: (n: number) => void };
}

export interface StartGdprDeleteCronOptions {
  db: Database;
  metrics?: GdprDeleteCronMetrics;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /** Override interval for tests. Defaults to GDPR_DELETE_INTERVAL_MS (5 min). */
  intervalMs?: number;
}

export interface GdprDeleteCronHandle {
  stop: () => void;
  /** Exposed for tests — awaits the current tick then runs one more. */
  tick: () => Promise<void>;
}

export function startGdprDeleteCron(
  opts: StartGdprDeleteCronOptions,
): GdprDeleteCronHandle {
  const interval = opts.intervalMs ?? GDPR_DELETE_INTERVAL_MS;
  let stopped = false;
  let currentTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await executeGdprDeletions({ db: opts.db });
      opts.metrics?.executedTotal?.inc(result.requestsProcessed);
      opts.metrics?.bodiesDeletedTotal?.inc(result.bodiesDeleted);
      opts.metrics?.reportsDeletedTotal?.inc(result.reportsDeleted);
      opts.metrics?.reportsByKeyDeletedTotal?.inc(result.reportsByKeyDeleted);
      opts.metrics?.clientSessionsDeletedTotal?.inc(result.clientSessionsDeleted);
      opts.metrics?.clientEventsDeletedTotal?.inc(result.clientEventsDeleted);
      opts.metrics?.failuresTotal?.inc(result.failures);
      if (result.requestsProcessed > 0) {
        opts.logger.info(result, "gdpr delete cron processed requests");
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "gdpr delete cron failed",
      );
    }
  }

  // Run immediately on start, then on interval.
  currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, interval);

  // Don't keep process alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: async () => {
      await currentTick;
      await runTick();
    },
  };
}
