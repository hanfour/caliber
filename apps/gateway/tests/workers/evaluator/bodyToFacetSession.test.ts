/**
 * Unit tests for bodyRowToFacetSession (Plan 4C follow-up #1).
 *
 * Pure-function adapter — no DB, no IO. Just exercises the various
 * Anthropic message shapes that arrive on a `BodyRow`.
 */

import { describe, it, expect } from "vitest";
import type { BodyRow } from "@caliber/evaluator";
import { bodyRowToFacetSession, isGatewayRequestId } from "../../../src/workers/evaluator/bodyToFacetSession.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function makeBody(overrides: Partial<BodyRow> = {}): BodyRow {
  return {
    requestId: "req-test",
    stopReason: "end_turn",
    clientUserAgent: null,
    clientSessionId: null,
    requestParams: null,
    requestBody: null,
    responseBody: null,
    ...overrides,
  };
}

describe("bodyRowToFacetSession", () => {
  it("1. plain user/assistant string content yields request turn(s) plus assistant response turn", () => {
    const body = makeBody({
      requestId: "req-string",
      requestBody: {
        messages: [
          { role: "user", content: "please refactor my login flow" },
        ],
      },
      responseBody: {
        content: [{ type: "text", text: "Here is the refactor..." }],
      },
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).not.toBeNull();
    expect(session!.requestId).toBe("req-string");
    expect(session!.orgId).toBe(ORG_ID);
    expect(session!.turns).toEqual([
      { role: "user", content: "please refactor my login flow" },
      { role: "assistant", content: "Here is the refactor..." },
    ]);
  });

  it("2. anthropic block-array content (text + tool_use) is flattened with markers", () => {
    const body = makeBody({
      requestId: "req-blocks",
      requestBody: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "fix the bug" },
              { type: "tool_use", name: "bash" },
              { type: "image", source: {} }, // should be skipped
            ],
          },
        ],
      },
      responseBody: {
        content: [
          { type: "text", text: "Looking..." },
          { type: "tool_use", name: "edit_file" },
        ],
      },
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).not.toBeNull();
    expect(session!.turns).toHaveLength(2);
    expect(session!.turns[0]).toEqual({
      role: "user",
      content: "fix the bug\n[tool_use: bash]",
    });
    // The response gets one assistant turn with both blocks combined
    expect(session!.turns[1]).toEqual({
      role: "assistant",
      content: "Looking...\n[tool_use: edit_file]",
    });
  });

  it("3. empty messages array with no response yields null", () => {
    const body = makeBody({
      requestId: "req-empty",
      requestBody: { messages: [] },
      responseBody: null,
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).toBeNull();
  });

  it("4. only system prompt (no messages) and no response yields null", () => {
    const body = makeBody({
      requestId: "req-system-only",
      requestBody: { system: "You are helpful." }, // no messages key
      responseBody: null,
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).toBeNull();
  });

  it("5. tool_result content is included with truncation marker prefix", () => {
    const body = makeBody({
      requestId: "req-tool-result",
      requestBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "stdout: build succeeded" },
                ],
              },
            ],
          },
        ],
      },
      responseBody: {
        content: [{ type: "text", text: "Great, let's continue." }],
      },
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).not.toBeNull();
    expect(session!.turns).toEqual([
      {
        role: "user",
        content: "[tool_result: stdout: build succeeded]",
      },
      { role: "assistant", content: "Great, let's continue." },
    ]);
  });

  it("ignores roles that aren't user or assistant (e.g. system message in array)", () => {
    const body = makeBody({
      requestId: "req-system-role",
      requestBody: {
        messages: [
          { role: "system", content: "ignore me" },
          { role: "user", content: "real ask" },
        ],
      },
      responseBody: { content: [{ type: "text", text: "ok" }] },
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).not.toBeNull();
    expect(session!.turns).toEqual([
      { role: "user", content: "real ask" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("returns null when both request and response yield no usable text", () => {
    const body = makeBody({
      requestId: "req-image-only",
      requestBody: {
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: {} }],
          },
        ],
      },
      responseBody: { content: [] },
    });

    const session = bodyRowToFacetSession(body, ORG_ID);
    expect(session).toBeNull();
  });
});

describe("isGatewayRequestId", () => {
  it("accepts gateway-issued UUID request ids", () => {
    expect(isGatewayRequestId("4cc24acf-6824-4f79-ab45-33ad964d5b11")).toBe(true);
  });

  it("rejects transcript-derived tx-* ids (not persistable: FK + uuid ledger ref)", () => {
    expect(
      isGatewayRequestId("tx-01fe8fa7-65d2-4551-9ea4-0171d47eb01a-a48e4dba-635c-49e2-b0ba-c13a7d4bb7ae"),
    ).toBe(false);
  });

  it("rejects other non-UUID ids (e.g. seeded test rows like req-4ie)", () => {
    expect(isGatewayRequestId("req-4ie")).toBe(false);
    expect(isGatewayRequestId("")).toBe(false);
  });
});
