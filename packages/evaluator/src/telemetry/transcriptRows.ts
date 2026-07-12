import type { BodyRow, UsageRow } from "../signals/types.js";

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

export interface TranscriptRows {
  usageRows: UsageRow[];
  bodyRows: BodyRow[];
  transcriptEventCount: number;
}

function isHumanTurn(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block === null || typeof block !== "object") return false;
    const type = (block as Record<string, unknown>).type;
    return type === "text" || type === "image";
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
  depth: number;
}

/** Map ordered transcript events to the human-turn grain used by scoring. */
export function mapEventsToRows(
  sessions: SessionMeta[],
  events: EventRow[],
): TranscriptRows {
  const meta = new Map(sessions.map((session) => [session.id, session]));
  const usageRows: UsageRow[] = [];
  const bodyRows: BodyRow[] = [];
  let currentSession: string | null = null;
  let current: Turn | null = null;
  let depthInSession = 0;

  const flush = () => {
    if (!current || currentSession === null) return;
    const session = meta.get(currentSession);
    const model = session?.modelProvider ?? "unknown";
    const requestId = `tx-${currentSession}-${current.firstEventId}`;
    usageRows.push({
      requestId,
      requestedModel: model,
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheReadTokens: current.cacheReadTokens,
      cacheCreationTokens: current.cacheCreationTokens,
      totalCost: 0,
    });
    const messages = [
      ...Array.from({ length: Math.max(0, current.depth - 1) }, () => ({
        role: "user",
        content: "",
      })),
      { role: "user", content: current.userContent },
    ];
    bodyRows.push({
      requestId,
      stopReason: null,
      clientUserAgent: session?.sourceClient ?? null,
      clientSessionId: currentSession,
      requestParams: null,
      responseBody: { content: current.assistantContent, stop_reason: null },
      requestBody: { model, messages },
    });
    current = null;
  };

  for (const event of events) {
    if (event.sessionId !== currentSession) {
      flush();
      currentSession = event.sessionId;
      depthInSession = 0;
    }
    if (event.role === "user" && isHumanTurn(event.content)) {
      flush();
      depthInSession += 1;
      current = {
        firstEventId: event.eventId,
        userContent: contentBlocks(event.content),
        assistantContent: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        depth: depthInSession,
      };
    } else if (event.role === "assistant" && current) {
      current.assistantContent.push(...contentBlocks(event.content));
      current.inputTokens += event.inputTokens ?? 0;
      current.outputTokens += event.outputTokens ?? 0;
      current.cacheReadTokens += event.cacheReadTokens ?? 0;
      current.cacheCreationTokens += event.cacheCreationTokens ?? 0;
    }
  }
  flush();
  return { usageRows, bodyRows, transcriptEventCount: bodyRows.length };
}
