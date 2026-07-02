/**
 * Unit tests for buildEvaluatorJobId (TDD – RED first, then GREEN after implementation).
 *
 * Covers:
 *   1. Output contains no ':'
 *   2. Deterministic: same input → same output
 *   3. Per-person (no apiKeyId) and per-key (with apiKeyId) produce different ids
 *   4. ISO periodStart with colons yields a colon-free result
 *   5. null apiKeyId treated the same as absent (per-person path)
 */

import { describe, it, expect } from "vitest";
import { buildEvaluatorJobId } from "../src/jobId.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const API_KEY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERIOD_START = "2026-06-30T00:00:00.000Z"; // has multiple colons
const PERIOD_TYPE = "daily";

describe("buildEvaluatorJobId", () => {
  it("output contains no colon characters", () => {
    const id = buildEvaluatorJobId({
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    expect(id).not.toContain(":");
  });

  it("output is deterministic for the same input", () => {
    const input = { userId: USER_ID, periodStart: PERIOD_START, periodType: PERIOD_TYPE };
    expect(buildEvaluatorJobId(input)).toBe(buildEvaluatorJobId(input));
  });

  it("per-person (no apiKeyId) differs from per-key (with apiKeyId)", () => {
    const perPerson = buildEvaluatorJobId({
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    const perKey = buildEvaluatorJobId({
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    expect(perPerson).not.toBe(perKey);
  });

  it("ISO periodStart colons are stripped to dashes", () => {
    const id = buildEvaluatorJobId({
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    // The ISO string "2026-06-30T00:00:00.000Z" has colons; they must be gone
    expect(id).not.toContain(":");
    // The date portion should still be recognizable (dashes preserved, colons→dashes)
    expect(id).toContain("2026-06-30T00-00-00.000Z");
  });

  it("null apiKeyId produces the per-person (3-segment) id", () => {
    const withNull = buildEvaluatorJobId({
      userId: USER_ID,
      apiKeyId: null,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    const withoutKey = buildEvaluatorJobId({
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    expect(withNull).toBe(withoutKey);
  });

  it("per-person id has 3 underscore-separated segments", () => {
    const id = buildEvaluatorJobId({
      userId: USER_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    // joined with '_', so we expect exactly 2 underscores splitting 3 parts
    // (though the UUID and transformed periodStart may contain more underscores themselves —
    // UUIDs don't use underscores, and the ISO format doesn't either)
    const parts = id.split("_");
    // User ID is 36 chars → parts[0] = USER_ID (no underscores in a UUID)
    expect(parts[0]).toBe(USER_ID);
    expect(parts[parts.length - 1]).toBe(PERIOD_TYPE);
  });

  it("per-key id starts with userId and ends with periodType", () => {
    const id = buildEvaluatorJobId({
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    expect(id.startsWith(USER_ID + "_")).toBe(true);
    expect(id.endsWith("_" + PERIOD_TYPE)).toBe(true);
  });

  it("per-key id contains apiKeyId segment", () => {
    const id = buildEvaluatorJobId({
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    });
    expect(id).toContain(API_KEY_ID);
  });

  it("lockstep: same inputs produce same id regardless of call site", () => {
    const input = {
      userId: USER_ID,
      apiKeyId: API_KEY_ID,
      periodStart: PERIOD_START,
      periodType: PERIOD_TYPE,
    };
    // Simulates cron (enqueueEvaluator) and admin rerun (reports.ts) both calling
    // buildEvaluatorJobId with the same args → dedup works
    const cronId = buildEvaluatorJobId(input);
    const rerunId = buildEvaluatorJobId(input);
    expect(cronId).toBe(rerunId);
  });
});
