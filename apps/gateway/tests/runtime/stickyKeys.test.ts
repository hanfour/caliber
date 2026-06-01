import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  sessionHashFromHeaders,
  previousResponseIdFromBody,
} from "../../src/runtime/stickyKeys.js";

describe("sessionHashFromHeaders", () => {
  it("hashes the X-Claude-Session-Id value (sha256 hex)", () => {
    const out = sessionHashFromHeaders({ "x-claude-session-id": "sess-abc" });
    expect(out).toBe(createHash("sha256").update("sess-abc").digest("hex"));
  });

  it("is deterministic for the same id and differs for different ids", () => {
    const a = sessionHashFromHeaders({ "x-claude-session-id": "s1" });
    const a2 = sessionHashFromHeaders({ "x-claude-session-id": "s1" });
    const b = sessionHashFromHeaders({ "x-claude-session-id": "s2" });
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
  });

  it("takes the first value when the header is an array", () => {
    const out = sessionHashFromHeaders({ "x-claude-session-id": ["first", "second"] });
    expect(out).toBe(createHash("sha256").update("first").digest("hex"));
  });

  it("returns undefined when the header is absent or empty", () => {
    expect(sessionHashFromHeaders({})).toBeUndefined();
    expect(sessionHashFromHeaders({ "x-claude-session-id": "" })).toBeUndefined();
    expect(sessionHashFromHeaders({ "x-claude-session-id": undefined })).toBeUndefined();
  });
});

describe("previousResponseIdFromBody", () => {
  it("returns the previous_response_id string when present", () => {
    expect(previousResponseIdFromBody({ previous_response_id: "resp_123" })).toBe("resp_123");
  });

  it("returns undefined for missing / empty / non-string / non-object", () => {
    expect(previousResponseIdFromBody({})).toBeUndefined();
    expect(previousResponseIdFromBody({ previous_response_id: "" })).toBeUndefined();
    expect(previousResponseIdFromBody({ previous_response_id: 42 })).toBeUndefined();
    expect(previousResponseIdFromBody(null)).toBeUndefined();
    expect(previousResponseIdFromBody("nope")).toBeUndefined();
  });
});
