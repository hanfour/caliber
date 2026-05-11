/**
 * Concrete `insertLedger` writer for the gateway evaluator worker
 * (Plan 4C, Task 3.3).
 *
 * `callWithCostTracking` (from `@caliber/evaluator`) calls `insertLedger(row)`
 * after each successful LLM response. This factory binds that contract to a
 * real Drizzle `Database`, persisting each call into `llm_usage_events`.
 *
 * Invariants:
 *   - The returned writer is a pure closure over `db`. Callers must not
 *     mutate it.
 *   - `costUsd` (a `number` on `LedgerRow`) is stringified at the boundary
 *     because Drizzle's `decimal` column type maps to `string` in TS. We
 *     intentionally keep the public `LedgerRow.costUsd` as `number` so
 *     producers (the LLM call site) can do arithmetic without casting.
 *   - `refType` / `refId` are coerced from `undefined` to `null` to match
 *     the nullable column shape; Drizzle treats `undefined` as "unset"
 *     (which would silently fall back to the default), and the columns
 *     have no default — so we must be explicit here.
 *
 * See spec §6 (Cost budget infrastructure).
 */

import type { Database } from "@caliber/db";
import { llmUsageEvents } from "@caliber/db";
import type { LedgerRow } from "@caliber/evaluator";
import type { GatewayMetrics } from "../../plugins/metrics.js";

/**
 * Build a concrete ledger-write function bound to the given Drizzle DB.
 * Returns an immutable closure suitable for passing as `insertLedger` to
 * `callWithCostTracking`.
 *
 * If `metrics` is provided, the writer also increments
 * `gwLlmCostUsdTotal{org_id, event_type, model}` by `row.costUsd` after each
 * successful insert. The argument is optional so existing call-sites and
 * integration tests that don't care about Prometheus stay green.
 */
export function createLedgerWriter(
  db: Database,
  metrics?: Pick<GatewayMetrics, "gwLlmCostUsdTotal">,
): (row: LedgerRow) => Promise<void> {
  return async (row) => {
    await db.insert(llmUsageEvents).values({
      orgId: row.orgId,
      eventType: row.eventType,
      model: row.model,
      tokensInput: row.tokensInput,
      tokensOutput: row.tokensOutput,
      // numeric/decimal column accepts string in Drizzle
      costUsd: String(row.costUsd),
      refType: row.refType ?? null,
      refId: row.refId ?? null,
    });
    metrics?.gwLlmCostUsdTotal.inc(
      {
        org_id: row.orgId,
        event_type: row.eventType,
        model: row.model,
      },
      row.costUsd,
    );
  };
}
