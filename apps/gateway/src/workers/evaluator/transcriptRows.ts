/**
 * Telemetry-source adapter for the evaluator (#257, turn-grain per #261).
 *
 * Maps ingested device transcripts (`client_sessions` / `client_events`) into
 * the `UsageRow[]` / `BodyRow[]` shapes the pure rule engine consumes, at
 * HUMAN-TURN grain rather than per-event.
 *
 * Transcript shape (verified against live data): a session interleaves
 *   - human turns   — user events whose content has a `text`/`image` block
 *   - assistant work — assistant events (thinking / text / tool_use)
 *   - tool results   — user events whose content is only `tool_result`
 * There is no turn_id, so a turn is reconstructed as "a human message plus all
 * assistant work and tool results until the next human message". Emitting one
 * BodyRow per human turn (not per assistant event) makes request_body keyword
 * signals measure the fraction of TURNS that show a pattern — volume-robust —
 * instead of being guaranteed to hit across thousands of per-event bodies
 * (the #261 saturation).
 */

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { clientEvents, clientSessions } from "@caliber/db";
import {
  mapEventsToRows,
  type EventRow,
  type SessionMeta,
  type TranscriptRows,
} from "@caliber/evaluator/telemetry";

export { mapEventsToRows } from "@caliber/evaluator/telemetry";
export type { EventRow, SessionMeta } from "@caliber/evaluator/telemetry";

export interface FetchTranscriptRowsInput {
  db: Database;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Fetch a user's transcript events in the window and map them to evaluator
 * rows at human-turn grain.
 */
export async function fetchTranscriptRows(
  input: FetchTranscriptRowsInput,
): Promise<TranscriptRows> {
  const { db, orgId, userId, periodStart, periodEnd } = input;

  const sessions = await db
    .select({
      id: clientSessions.id,
      sourceClient: clientSessions.sourceClient,
      modelProvider: clientSessions.modelProvider,
    })
    .from(clientSessions)
    .where(and(eq(clientSessions.orgId, orgId), eq(clientSessions.userId, userId)));

  if (sessions.length === 0) {
    return { usageRows: [], bodyRows: [], transcriptEventCount: 0 };
  }

  const sessionIds = sessions.map((s) => s.id);

  const events = await db
    .select({
      sessionId: clientEvents.sessionId,
      eventId: clientEvents.eventId,
      role: clientEvents.role,
      content: clientEvents.content,
      inputTokens: clientEvents.inputTokens,
      outputTokens: clientEvents.outputTokens,
      cacheReadTokens: clientEvents.cacheReadTokens,
      cacheCreationTokens: clientEvents.cacheCreationTokens,
    })
    .from(clientEvents)
    .where(
      and(
        inArray(clientEvents.sessionId, sessionIds),
        gte(clientEvents.timestamp, periodStart),
        lt(clientEvents.timestamp, periodEnd),
      ),
    )
    .orderBy(asc(clientEvents.sessionId), asc(clientEvents.timestamp));

  return mapEventsToRows(sessions, events);
}
