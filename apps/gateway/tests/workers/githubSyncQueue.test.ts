import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_SYNC_JOB_NAME,
  GithubSyncJobPayload,
  buildGithubSyncJobId,
  enqueueGithubSync,
  type QueueLike,
} from "../../src/workers/githubSync/queue.js";

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
});
