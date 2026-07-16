import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_DELIVERY_JOB_NAME,
  GithubDeliveryJobPayload,
  buildGithubDeliveryJobId,
  enqueueGithubDelivery,
  type QueueLike,
} from "../src/index.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";
const USER = "0b7e7d1e-0000-4000-8000-000000000002";
const PAYLOAD = {
  orgId: ORG, userId: USER,
  periodStart: "2026-06-16T00:00:00.000Z", periodEnd: "2026-07-16T00:00:00.000Z",
  periodType: "daily" as const, triggeredBy: "manual" as const,
};

describe("buildGithubDeliveryJobId", () => {
  it("is deterministic, colon-free, and time-bucketed", () => {
    const id = buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: PAYLOAD.periodStart });
    expect(id).toBe(buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: PAYLOAD.periodStart }));
    expect(id).not.toContain(":");
    expect(id).toContain(USER);
    // different window → different id (no cross-window dedup)
    expect(buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: "2026-06-17T00:00:00.000Z" })).not.toBe(id);
  });
});

describe("enqueueGithubDelivery", () => {
  it("plain add without regenerate (cron path — no remove)", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    const queue: QueueLike = { add, remove };
    const { jobId } = await enqueueGithubDelivery(queue, PAYLOAD);
    expect(remove).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(GITHUB_DELIVERY_JOB_NAME, PAYLOAD, { jobId });
  });

  it("remove-before-add with regenerate: true (manual path)", async () => {
    const calls: string[] = [];
    const queue: QueueLike = {
      add: vi.fn(async () => void calls.push("add")),
      remove: vi.fn(async () => void calls.push("remove")),
    };
    await enqueueGithubDelivery(queue, PAYLOAD, { regenerate: true });
    expect(calls).toEqual(["remove", "add"]);
  });

  it("regenerate works when the queue has no remove method, and remove failure never blocks add", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueGithubDelivery({ add }, PAYLOAD, { regenerate: true });
    expect(add).toHaveBeenCalledTimes(1);
    const failingRemove: QueueLike = { add, remove: vi.fn().mockRejectedValue(new Error("boom")) };
    await enqueueGithubDelivery(failingRemove, PAYLOAD, { regenerate: true });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid payloads (bad uuid, bad triggeredBy)", async () => {
    const queue: QueueLike = { add: vi.fn() };
    await expect(enqueueGithubDelivery(queue, { ...PAYLOAD, orgId: "nope" })).rejects.toThrow();
    expect(GithubDeliveryJobPayload.safeParse({ ...PAYLOAD, triggeredBy: "interval" }).success).toBe(false);
  });
});
