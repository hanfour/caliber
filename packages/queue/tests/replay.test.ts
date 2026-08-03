/**
 * Unit tests for the replay queue + enqueue wrapper (Task 4).
 *
 * Uses a fake queue (no Redis). Covers:
 *   1. jobId is the bare runId uuid (no colon) — dedup + no-composed-string guarantee
 *   2. Invalid payload throws and never calls queue.add (programmer error, not transient)
 *   3. ReplayJobPayload rejects a payload missing sourceRequestId
 */

import { describe, it, expect, vi } from "vitest";
import {
  enqueueReplay,
  ReplayJobPayload,
  REPLAY_JOB_NAME,
} from "../src/replay.js";

const valid = {
  runId: "3f1b7c4e-9a2d-4f77-8b0e-1c2d3e4f5a6b",
  orgId: "0a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d",
  sourceRequestId: "req-abc",
  targetModel: "claude-sonnet-5",
};

describe("enqueueReplay", () => {
  it("以 runId 作為 jobId（裸 uuid，不含冒號）", async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const res = await enqueueReplay(queue, valid);
    expect(res.jobId).toBe(valid.runId);
    expect(res.jobId).not.toContain(":");
    expect(queue.add).toHaveBeenCalledWith(REPLAY_JOB_NAME, valid, {
      jobId: valid.runId,
    });
  });

  it("payload 不合法時擲錯（視為程式錯誤，非暫時性狀況）", async () => {
    const queue = { add: vi.fn() };
    await expect(
      enqueueReplay(queue, { ...valid, targetModel: "" }),
    ).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("schema 拒絕缺少 sourceRequestId 的 payload", () => {
    const { sourceRequestId: _drop, ...bad } = valid;
    expect(() => ReplayJobPayload.parse(bad)).toThrow();
  });
});
