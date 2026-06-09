import { describe, it, expect, beforeEach, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { maybeSendBudgetAlert } from "../../src/workers/evaluator/budgetAlertWebhook.js";

// ioredis-mock v8 shares a global in-memory store across all new RedisMock()
// instances in the same process. Flush between tests so state from one test
// (e.g. a successful POST that writes the dedup key) does not bleed into the
// next test that creates its own `new RedisMock()`.
beforeEach(async () => {
  await new RedisMock().flushall();
});

const noopLog = { warn: () => {} } as any;
function deps(over: Partial<{ redis: any; fetch: any; webhookUrl?: string; now: () => Date }> = {}) {
  return {
    redis: over.redis ?? new RedisMock(),
    fetch: over.fetch ?? vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    webhookUrl: "webhookUrl" in over ? over.webhookUrl : "https://hooks.example/x",
    logger: noopLog,
    now: over.now ?? (() => new Date("2026-06-09T00:00:00Z")),
  };
}
const evt = { orgId: "o1", event: "warn" as const, monthToDate: "9.0", budget: "10.0" };

describe("maybeSendBudgetAlert", () => {
  it("POSTs once on 2xx + writes dedup key", async () => {
    const d = deps();
    await maybeSendBudgetAlert(d, evt);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(await d.redis.get("alert-sent:warn:o1:2026-06")).toBe("1");
    const body = JSON.parse(d.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ event: "warn", orgId: "o1" });
    expect(JSON.stringify(body)).not.toMatch(/ak_|token|secret/i);
  });
  it("deduped: second same-month warn does not POST", async () => {
    const redis = new RedisMock();
    const d1 = deps({ redis }); await maybeSendBudgetAlert(d1, evt);
    const d2 = deps({ redis }); await maybeSendBudgetAlert(d2, evt);
    expect(d2.fetch).not.toHaveBeenCalled();
  });
  it("no webhook url → no POST, no throw", async () => {
    const d = deps({ webhookUrl: undefined });
    await maybeSendBudgetAlert(d, evt);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("non-2xx → does NOT write dedup (retried next time), no throw", async () => {
    const redis = new RedisMock();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await maybeSendBudgetAlert(deps({ redis, fetch }), evt);
    expect(await redis.get("alert-sent:warn:o1:2026-06")).toBeNull();
  });
  it("exceeded dedup key includes behavior", async () => {
    const redis = new RedisMock();
    await maybeSendBudgetAlert(deps({ redis }), { orgId: "o1", event: "exceeded", monthToDate: "11", budget: "10", behavior: "halt" });
    expect(await redis.get("alert-sent:exceeded:o1:2026-06:halt")).toBe("1");
  });
  it("releases the in-flight lock even when fetch throws (no 30s stranded lock)", async () => {
    const redis = new RedisMock();
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    await maybeSendBudgetAlert(deps({ redis, fetch }), evt);
    expect(await redis.get("alert-sent:warn:o1:2026-06:lock")).toBeNull();
    expect(await redis.get("alert-sent:warn:o1:2026-06")).toBeNull(); // not marked (no 2xx)
  });
});
