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
  /** Count of human turns mapped — for source_breakdown. */
  transcriptEventCount: number;
}

export interface SessionMeta {
  id: string;
  sourceClient: string | null;
  modelProvider: string | null;
}

export interface EventRow {
  sessionId: string;
  eventId: string;
  role: string | null;
  content: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

// A user event is a HUMAN turn boundary only if its content carries a text or
// image block. tool_result-only user events are intra-turn (they feed the
// assistant) and must NOT start a new turn.
function isHumanTurn(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (b === null || typeof b !== "object") return false;
    const t = (b as Record<string, unknown>).type;
    return t === "text" || t === "image";
  });
}

function contentBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

interface Turn {
  firstEventId: string;
  userContent: unknown[];
  assistantContent: unknown[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  depth: number; // conversation depth within the session (for iteration_count)
}

/**
 * Pure mapping: group ordered events into human turns and emit one
 * UsageRow + BodyRow per turn. Exported for unit testing without a DB.
 * `events` MUST be ordered by (sessionId, timestamp).
 */
export function mapEventsToRows(
  sessions: SessionMeta[],
  events: EventRow[],
): TranscriptRows {
  const meta = new Map(sessions.map((s) => [s.id, s]));
  const usageRows: UsageRow[] = [];
  const bodyRows: BodyRow[] = [];

  let curSession: string | null = null;
  let cur: Turn | null = null;
  let depthInSession = 0;

  const flush = () => {
    if (!cur || curSession === null) return;
    const m = meta.get(curSession);
    const model = m?.modelProvider ?? "unknown";
    const requestId = `tx-${curSession}-${cur.firstEventId}`;
    usageRows.push({
      requestId,
      requestedModel: model,
      inputTokens: cur.inputTokens,
      outputTokens: cur.outputTokens,
      cacheReadTokens: cur.cacheReadTokens,
      cacheCreationTokens: cur.cacheCreationTokens,
      totalCost: 0,
    });
    // messages length = conversation depth so iteration_count reflects how
    // deep the human drove the session; the last message carries the human
    // text so request_body keyword signals can find it, and padding entries
    // are empty so they add no keyword noise.
    const messages = [
      ...Array.from({ length: Math.max(0, cur.depth - 1) }, () => ({
        role: "user",
        content: "",
      })),
      { role: "user", content: cur.userContent },
    ];
    bodyRows.push({
      requestId,
      stopReason: null,
      clientUserAgent: m?.sourceClient ?? null,
      clientSessionId: curSession,
      requestParams: null,
      responseBody: { content: cur.assistantContent, stop_reason: null },
      requestBody: { model, messages },
    });
    cur = null;
  };

  for (const ev of events) {
    if (ev.sessionId !== curSession) {
      flush();
      curSession = ev.sessionId;
      depthInSession = 0;
    }

    if (ev.role === "user" && isHumanTurn(ev.content)) {
      flush();
      depthInSession += 1;
      cur = {
        firstEventId: ev.eventId,
        userContent: contentBlocks(ev.content),
        assistantContent: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        depth: depthInSession,
      };
    } else if (ev.role === "assistant") {
      if (!cur) {
        // Assistant work before any human message (rare) — open a turn with
        // no user content so its tokens/tools are still counted.
        depthInSession += 1;
        cur = {
          firstEventId: ev.eventId,
          userContent: [],
          assistantContent: [],
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          depth: depthInSession,
        };
      }
      cur.assistantContent.push(...contentBlocks(ev.content));
      cur.inputTokens += ev.inputTokens ?? 0;
      cur.outputTokens += ev.outputTokens ?? 0;
      cur.cacheReadTokens += ev.cacheReadTokens ?? 0;
      cur.cacheCreationTokens += ev.cacheCreationTokens ?? 0;
    }
    // else: user tool_result → belongs to the current turn, no boundary.
  }
  flush();

  return { usageRows, bodyRows, transcriptEventCount: bodyRows.length };
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
