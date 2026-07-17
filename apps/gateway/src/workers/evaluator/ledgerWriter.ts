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
 *   - `usage_log_request_id` is left `null` — `LedgerRow` (the facet path)
 *     has no request id to persist (0033 note). NULL rows are exempt from
 *     the new `llm_usage_request_dedup_idx` partial index, so this path
 *     keeps deduping on the legacy `(ref_type, ref_id, event_type)` index.
 *   - The metrics increment only fires on an ACTUAL insert (`.returning()`
 *     non-empty). A deduped no-op previously still incremented
 *     `gwLlmCostUsdTotal`, double-counting cost on every BullMQ retry that
 *     hit the dedup conflict. Mirrors `writeDeepAnalysisLedger`'s `written`
 *     gate.
 *
 * See spec §6 (Cost budget infrastructure).
 */

import { sql } from "drizzle-orm";
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
    const inserted = await db
      .insert(llmUsageEvents)
      .values({
        orgId: row.orgId,
        eventType: row.eventType,
        model: row.model,
        tokensInput: row.tokensInput,
        tokensOutput: row.tokensOutput,
        // numeric/decimal column accepts string in Drizzle
        costUsd: String(row.costUsd),
        refType: row.refType ?? null,
        refId: row.refId ?? null,
        // LedgerRow (the facet path) carries no upstream request id — left
        // null and thus exempt from llm_usage_request_dedup_idx (0033).
        usageLogRequestId: null,
      })
      // Guard against BullMQ crash-window retries double-inserting the same
      // facet-extraction row. Targets `llm_usage_dedup_idx` on
      // (ref_type, ref_id, event_type) WHERE ref_id IS NOT NULL AND
      // usage_log_request_id IS NULL (narrowed by migration 0033 so this
      // legacy index no longer collides with the deep-analysis path, which
      // now always carries a request id and dedups on
      // `llm_usage_request_dedup_idx` instead). The predicate here MUST
      // match the index's WHERE clause verbatim or Postgres cannot infer an
      // arbiter (42P10) — this writer always sets usageLogRequestId: null
      // above, so the predicate always holds for its own rows.
      // Rows with a null ref_id are NOT covered by the partial index and are
      // allowed to insert freely (no dedup attempt).
      .onConflictDoNothing({
        target: [
          llmUsageEvents.refType,
          llmUsageEvents.refId,
          llmUsageEvents.eventType,
        ],
        where: sql`${llmUsageEvents.refId} IS NOT NULL AND ${llmUsageEvents.usageLogRequestId} IS NULL`,
      })
      .returning({ id: llmUsageEvents.id });

    // Only count cost when a NEW row actually landed — a deduped no-op
    // (BullMQ retry hitting the conflict) must not double-increment.
    if (inserted.length > 0) {
      metrics?.gwLlmCostUsdTotal.inc(
        {
          org_id: row.orgId,
          event_type: row.eventType,
          model: row.model,
        },
        row.costUsd,
      );
    }
  };
}
