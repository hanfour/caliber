import type { Redis } from "ioredis";

// Active webhook alert for org budget warn/exceeded (spec §4.3). Fire-and-forget:
// never throws, never blocks the caller. send-then-mark dedup: only write the
// monthly dedup key AFTER a 2xx, so a failed POST is retried next time instead
// of permanently suppressing alerts for that org+month.

export interface BudgetAlertEvent {
  orgId: string;
  event: "warn" | "exceeded";
  monthToDate: string; // decimal string
  budget: string; // decimal string
  behavior?: "degrade" | "halt"; // only for exceeded
}

export interface BudgetAlertDeps {
  redis: Redis;
  fetch: typeof globalThis.fetch;
  webhookUrl?: string;
  logger: { warn: (obj: unknown, msg?: string) => void };
  now: () => Date;
}

const ALERT_TTL_SEC = 35 * 24 * 60 * 60; // ~longer than any month
const INFLIGHT_TTL_SEC = 30;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dedupKey(e: BudgetAlertEvent, month: string): string {
  return e.event === "exceeded"
    ? `alert-sent:exceeded:${e.orgId}:${month}:${e.behavior ?? "unknown"}`
    : `alert-sent:warn:${e.orgId}:${month}`;
}

export async function maybeSendBudgetAlert(
  deps: BudgetAlertDeps,
  e: BudgetAlertEvent,
): Promise<void> {
  if (!deps.webhookUrl) return;
  const month = monthKey(deps.now());
  const dk = dedupKey(e, month);
  try {
    if ((await deps.redis.exists(dk)) === 1) return; // already alerted this month
    // short in-flight lock to avoid concurrent double-send
    const lock = await deps.redis.set(`${dk}:lock`, "1", "EX", INFLIGHT_TTL_SEC, "NX");
    if (lock === null) return;

    const res = await deps.fetch(deps.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: e.event,
        orgId: e.orgId,
        monthToDate: e.monthToDate,
        budget: e.budget,
        ...(e.behavior ? { behavior: e.behavior } : {}),
        ts: deps.now().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      await deps.redis.set(dk, "1", "EX", ALERT_TTL_SEC); // mark only on success
    } else {
      deps.logger.warn({ status: res.status, orgId: e.orgId }, "budget_alert_webhook_non_2xx");
    }
    await deps.redis.del(`${dk}:lock`);
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: e.orgId },
      "budget_alert_webhook_failed",
    );
  }
}
