/**
 * Telemetry-source adapter for the evaluator (#257).
 *
 * Maps ingested device transcripts (`client_sessions` / `client_events`) into
 * the exact `UsageRow[]` / `BodyRow[]` shapes the pure rule engine
 * (`scoreWithRules`) already consumes, so a member who never routes through the
 * gateway still gets scored from their `caliber login` telemetry alone.
 *
 * `client_events.content` stores the raw Anthropic `message.content[]` array
 * (thinking / text / tool_use for assistant events; text / tool_result for
 * user events), so reconstructing a wire-shaped `responseBody` is just wrapping
 * that array as `{ content, stop_reason }`. This drives tool_diversity,
 * keyword, extended_thinking, iteration, and client_mix signals directly; the
 * token columns drive threshold / cache_read_ratio / model_diversity.
 */

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { clientEvents, clientSessions } from "@caliber/db";
import type { BodyRow, UsageRow } from "@caliber/evaluator";

export interface FetchTranscriptRowsInput {
  db: Database;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface TranscriptRows {
  usageRows: UsageRow[];
  bodyRows: BodyRow[];
  /** Count of assistant (usage-bearing) events mapped — for source_breakdown. */
  transcriptEventCount: number;
}

// Synthetic request id for a transcript-derived row. Prefixed so it can never
// collide with a gateway request id (which are opaque UUIDs / provider ids).
function transcriptRequestId(sessionId: string, eventId: string): string {
  return `tx-${sessionId}-${eventId}`;
}

/**
 * Fetch and shape a user's transcript events in the window into evaluator rows.
 *
 * One `UsageRow` + `BodyRow` is emitted per assistant event (the usage-bearing,
 * content-producing side of a turn). Each assistant event's `requestBody` is
 * paired with the most recent preceding user event's content in the same
 * session, walked by timestamp — enough for request-body keyword signals
 * without a full turn-tree reconstruction (deferred; see the plan doc).
 */
export async function fetchTranscriptRows(
  input: FetchTranscriptRowsInput,
): Promise<TranscriptRows> {
  const { db, orgId, userId, periodStart, periodEnd } = input;

  // 1. Sessions owned by this user in this org (userId lives on the session,
  //    not the event). Carry sourceClient for the client_mix signal.
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

  const sessionMeta = new Map(sessions.map((s) => [s.id, s]));
  const sessionIds = sessions.map((s) => s.id);

  // 2. Events for those sessions inside the window, ordered so the
  //    preceding-user-event pairing below is a single forward pass.
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

  const usageRows: UsageRow[] = [];
  const bodyRows: BodyRow[] = [];
  const lastUserContent = new Map<string, unknown>();

  for (const ev of events) {
    if (ev.role === "user") {
      lastUserContent.set(ev.sessionId, ev.content);
      continue;
    }
    if (ev.role !== "assistant") continue;

    const meta = sessionMeta.get(ev.sessionId);
    const requestId = transcriptRequestId(ev.sessionId, ev.eventId);
    const model = meta?.modelProvider ?? "unknown";

    usageRows.push({
      requestId,
      requestedModel: model,
      inputTokens: ev.inputTokens ?? 0,
      outputTokens: ev.outputTokens ?? 0,
      cacheReadTokens: ev.cacheReadTokens ?? 0,
      cacheCreationTokens: ev.cacheCreationTokens ?? 0,
      // client_events carries no per-event cost; cost signals degrade
      // gracefully (token-based signals still score). Tracked as a follow-up
      // to compute via model_pricing.
      totalCost: 0,
    });

    bodyRows.push({
      requestId,
      stopReason: null,
      clientUserAgent: meta?.sourceClient ?? null,
      clientSessionId: ev.sessionId,
      requestParams: null,
      responseBody: { content: ev.content, stop_reason: null },
      requestBody: {
        model,
        messages: [{ role: "user", content: lastUserContent.get(ev.sessionId) ?? [] }],
      },
    });
  }

  return { usageRows, bodyRows, transcriptEventCount: usageRows.length };
}
