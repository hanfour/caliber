import type { Database } from "@caliber/db";
import { auditLogs } from "@caliber/db";

export interface NotifyGdprRequestedInput {
  db: Database;
  orgId: string;
  userId: string;
  requestedByUserId: string;
  requestId: string;
  scope: "bodies" | "bodies_and_reports";
  reason?: string | null;
  logger: {
    info: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Fires when a GDPR delete request is submitted.
 * Writes an audit_logs row + emits a structured log for observability.
 * Email integration lands in Plan 4D.
 */
export async function notifyGdprRequested(
  input: NotifyGdprRequestedInput,
): Promise<void> {
  const {
    db,
    orgId,
    userId,
    requestedByUserId,
    requestId,
    scope,
    reason,
    logger,
  } = input;

  // Structured log for observability stream
  logger.info(
    {
      type: "gdpr_delete_requested",
      orgId,
      userId,
      requestedByUserId,
      requestId,
      scope,
      hasReason: !!reason,
    },
    "gdpr delete request submitted",
  );

  // Audit log row for admin compliance review
  await db.insert(auditLogs).values({
    orgId,
    actorUserId: requestedByUserId,
    action: "gdpr.delete_requested",
    targetType: "user",
    targetId: userId,
    metadata: {
      requestId,
      scope,
      reason: reason ?? null,
    },
  });
}
