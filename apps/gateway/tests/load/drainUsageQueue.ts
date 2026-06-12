import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import type { Database } from "@caliber/db";

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export async function usageLogCount(db: Database): Promise<number> {
  const rows = await db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  return rows[0]?.c ?? 0;
}

/** Block until `usage_logs` reaches `expected` rows (the BullMQ worker batches on a ~1s timer). */
export async function drainUsageQueue(
  db: Database,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(async () => (await usageLogCount(db)) >= expected, timeoutMs);
}
