import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_SYNC_JOB_NAME,
  GithubSyncJobPayload,
  buildGithubSyncJobId,
  enqueueGithubSync,
  type QueueLike,
} from "../src/index.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";

describe("buildGithubSyncJobId", () => {
  it("is deterministic and contains no colons", () => {
    const id = buildGithubSyncJobId({ orgId: ORG });
    expect(id).toBe(buildGithubSyncJobId({ orgId: ORG }));
    expect(id).not.toContain(":");
    expect(id).toContain(ORG);
  });
});

describe("enqueueGithubSync", () => {
  it("validates payload and adds with the deterministic jobId", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue: QueueLike = { add };
    const { jobId } = await enqueueGithubSync(queue, {
      orgId: ORG,
      triggeredBy: "manual",
    });
    expect(add).toHaveBeenCalledWith(
      GITHUB_SYNC_JOB_NAME,
      { orgId: ORG, triggeredBy: "manual" },
      { jobId },
    );
  });

  it("rejects an invalid payload", async () => {
    const queue: QueueLike = { add: vi.fn() };
    await expect(
      enqueueGithubSync(queue, { orgId: "not-a-uuid", triggeredBy: "manual" }),
    ).rejects.toThrow();
  });

  it("zod schema rejects unknown triggeredBy", () => {
    expect(
      GithubSyncJobPayload.safeParse({ orgId: ORG, triggeredBy: "cron" })
        .success,
    ).toBe(false);
  });

  // Regression (C1): BullMQ dedups `add` against a job hash that still
  // exists for a given jobId — including COMPLETED/FAILED jobs, not just
  // active ones — and our jobId has no time component, so a stale
  // completed-job hash would silently swallow every later enqueue for the
  // same org. `enqueueGithubSync` must remove the stale hash immediately
  // before adding.
  it("calls remove before add with the same jobId, when remove exists", async () => {
    const calls: string[] = [];
    const add = vi.fn().mockImplementation(async () => {
      calls.push("add");
    });
    const remove = vi.fn().mockImplementation(async () => {
      calls.push("remove");
    });
    const queue: QueueLike = { add, remove };
    const { jobId } = await enqueueGithubSync(queue, {
      orgId: ORG,
      triggeredBy: "manual",
    });
    expect(remove).toHaveBeenCalledWith(jobId);
    expect(add).toHaveBeenCalledWith(
      GITHUB_SYNC_JOB_NAME,
      { orgId: ORG, triggeredBy: "manual" },
      { jobId },
    );
    // remove-before-add ordering matters: adding first would let BullMQ
    // dedup against the not-yet-removed stale hash.
    expect(calls).toEqual(["remove", "add"]);
  });

  it("still adds successfully when the queue has no remove method", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue: QueueLike = { add }; // no `remove` — e.g. a minimal test double
    const { jobId } = await enqueueGithubSync(queue, {
      orgId: ORG,
      triggeredBy: "manual",
    });
    expect(add).toHaveBeenCalledWith(
      GITHUB_SYNC_JOB_NAME,
      { orgId: ORG, triggeredBy: "manual" },
      { jobId },
    );
  });

  it("proceeds to add even when remove throws (best-effort cleanup)", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockRejectedValue(new Error("redis blip"));
    const queue: QueueLike = { add, remove };
    const { jobId } = await enqueueGithubSync(queue, {
      orgId: ORG,
      triggeredBy: "manual",
    });
    expect(remove).toHaveBeenCalledWith(jobId);
    expect(add).toHaveBeenCalledWith(
      GITHUB_SYNC_JOB_NAME,
      { orgId: ORG, triggeredBy: "manual" },
      { jobId },
    );
  });
});
