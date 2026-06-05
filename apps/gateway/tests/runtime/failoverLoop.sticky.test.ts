import { describe, it, expect } from "vitest";
import { runFailover } from "../../src/runtime/failoverLoop.js";
import type {
  AccountScheduler,
  ScheduleRequest,
  ScheduleResult,
} from "../../src/runtime/scheduler.js";

// Minimal scheduler that records every select() request and always returns
// the same account, so we can assert what runFailover forwards.
function recordingScheduler(): {
  scheduler: AccountScheduler;
  seen: ScheduleRequest[];
} {
  const seen: ScheduleRequest[] = [];
  const account = {
    id: "acct-1",
    concurrency: 5,
    platform: "anthropic",
    type: "anthropic",
    priority: 0,
    groupId: "grp-1",
  };
  const result: ScheduleResult = {
    account,
    decision: {
      layer: "load_balance",
      stickyHit: false,
      candidateCount: 1,
      selectedAccountId: account.id,
      selectedAccountType: account.type,
      platform: account.platform,
      loadSkew: 0,
      latencyMs: 0,
    },
    release: async () => {},
  };
  const scheduler = {
    select: async (req: ScheduleRequest) => {
      seen.push(req);
      return result;
    },
    reportResult: () => {},
    reportSwitch: () => {},
    snapshotRuntimeStats: () => ({}) as never,
  } as AccountScheduler;
  return { scheduler, seen };
}

describe("runFailover — sticky key forwarding to scheduler.select", () => {
  it("forwards previousResponseId (Layer 1) and sessionHash (Layer 2)", async () => {
    const { scheduler, seen } = recordingScheduler();
    const out = await runFailover({
      db: {} as never,
      orgId: "org-1",
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      groupId: "grp-1",
      maxSwitches: 3,
      scheduler,
      previousResponseId: "resp_9",
      sessionHash: "hash_x",
      attempt: async (acct) => `ok:${acct.id}`,
    });
    expect(out).toBe("ok:acct-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      orgId: "org-1",
      groupId: "grp-1",
      previousResponseId: "resp_9",
      sessionHash: "hash_x",
    });
  });

  it("passes them through as undefined when the caller omits them", async () => {
    const { scheduler, seen } = recordingScheduler();
    await runFailover({
      db: {} as never,
      orgId: "org-1",
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 1,
      scheduler,
      attempt: async () => "x",
    });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.previousResponseId).toBeUndefined();
    expect(req.sessionHash).toBeUndefined();
  });
});
