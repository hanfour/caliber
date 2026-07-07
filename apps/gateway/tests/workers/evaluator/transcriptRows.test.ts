import { describe, it, expect } from "vitest";
import {
  mapEventsToRows,
  type EventRow,
  type SessionMeta,
} from "../../../src/workers/evaluator/transcriptRows.js";

const session: SessionMeta = {
  id: "s1",
  sourceClient: "claude-code",
  modelProvider: "anthropic",
};

function ev(p: Partial<EventRow> & { eventId: string; role: string }): EventRow {
  return {
    sessionId: "s1",
    content: [],
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...p,
  };
}

describe("mapEventsToRows — turn-grain (#261)", () => {
  it("groups a human message + its assistant work + tool results into ONE turn", () => {
    // Human turn: user text → assistant tool_use → user tool_result → assistant text.
    const events: EventRow[] = [
      ev({ eventId: "u1", role: "user", content: [{ type: "text", text: "please refactor this" }] }),
      ev({
        eventId: "a1",
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: {} }],
        outputTokens: 50,
      }),
      ev({ eventId: "tr1", role: "user", content: [{ type: "tool_result", content: "..." }] }),
      ev({
        eventId: "a2",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        outputTokens: 30,
      }),
    ];

    const { usageRows, bodyRows, transcriptEventCount } = mapEventsToRows(
      [session],
      events,
    );

    // ONE turn, not 4 events.
    expect(transcriptEventCount).toBe(1);
    expect(bodyRows).toHaveLength(1);
    expect(usageRows).toHaveLength(1);

    // Tokens summed across the turn's assistant events.
    expect(usageRows[0]!.outputTokens).toBe(80);

    // responseBody aggregates all assistant blocks → tool_diversity sees Read.
    const rb = bodyRows[0]!.responseBody as { content: Array<{ type: string; name?: string }> };
    expect(rb.content.some((b) => b.type === "tool_use" && b.name === "Read")).toBe(true);

    // The human text lands in requestBody so request_body keyword can find it,
    // and the tool_result did NOT start a new turn.
    expect(JSON.stringify(bodyRows[0]!.requestBody)).toContain("refactor");
    expect(bodyRows[0]!.clientUserAgent).toBe("claude-code");
  });

  it("counts human turns, not events — two human messages → two turns", () => {
    const events: EventRow[] = [
      ev({ eventId: "u1", role: "user", content: [{ type: "text", text: "hi" }] }),
      ev({ eventId: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] }),
      ev({ eventId: "u2", role: "user", content: [{ type: "text", text: "compare A and B" }] }),
      ev({ eventId: "a2", role: "assistant", content: [{ type: "text", text: "ok" }] }),
    ];
    const { bodyRows, transcriptEventCount } = mapEventsToRows([session], events);
    expect(transcriptEventCount).toBe(2);
    // iteration_count reads messages.length as conversation depth: 2nd turn is depth 2.
    const msgs2 = (bodyRows[1]!.requestBody as { messages: unknown[] }).messages;
    expect(msgs2).toHaveLength(2);
  });

  it("a request_body keyword ratio is over turns, not events — sparse term stays sparse", () => {
    // 1 of 3 human turns mentions the term; each turn has many assistant events.
    const events: EventRow[] = [
      ev({ eventId: "u1", role: "user", content: [{ type: "text", text: "refactor please" }] }),
      ...Array.from({ length: 10 }, (_, i) =>
        ev({ eventId: `a1-${i}`, role: "assistant", content: [{ type: "text", text: "x" }] }),
      ),
      ev({ eventId: "u2", role: "user", content: [{ type: "text", text: "hello" }] }),
      ...Array.from({ length: 10 }, (_, i) =>
        ev({ eventId: `a2-${i}`, role: "assistant", content: [{ type: "text", text: "y" }] }),
      ),
      ev({ eventId: "u3", role: "user", content: [{ type: "text", text: "thanks" }] }),
    ];
    const { bodyRows } = mapEventsToRows([session], events);
    // 3 turns → 3 bodies (not 23 events); 1 contains the term → ratio 1/3.
    expect(bodyRows).toHaveLength(3);
    const withTerm = bodyRows.filter((b) =>
      JSON.stringify(b.requestBody).includes("refactor"),
    ).length;
    expect(withTerm).toBe(1);
  });
});
