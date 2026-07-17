/**
 * Metric-emitting wrapper around `enforceBudget` from `@caliber/evaluator`
 * (Plan 4C, Part 7).
 *
 * The pure budget logic lives in `@caliber/evaluator/src/budget/enforceBudget`
 * and stays free of any infrastructure concerns. This adapter binds it to
 * the gateway's Prometheus registry so we can observe:
 *
 *   - `gw_llm_budget_warn_total{org_id}` once an org's month-to-date spend
 *     crosses 80% of its monthly budget (soft warning — the call still went
 *     through).
 *   - `gw_llm_budget_exceeded_total{org_id, behavior}` when `enforceBudget`
 *     throws (`degrade` for `BudgetExceededDegrade`, `halt` for
 *     `BudgetExceededHalt`).
 *
 * Notes:
 *   - The warn check re-loads org+month-spend after a successful enforce so
 *     it reflects post-allowance state. This is a small extra round-trip but
 *     only runs on the happy path; budget breaches short-circuit through the
 *     catch.
 *   - NULL budget means "unlimited" — no warn metric is ever emitted in that
 *     case (the threshold check requires a finite budget).
 *   - Errors that aren't budget breaches propagate untouched without any
 *     metric emission.
 *   - `metrics` is optional (Task 5, delivery budget parity): a caller that
 *     only wants the `onBudgetEvent` webhook alert (no Prometheus counters)
 *     can omit it — the two `.inc(...)` call sites below are `?.`-guarded so
 *     this wrapper still fires `onBudgetEvent` without a metrics object.
 */

import {
  enforceBudget,
  type EnforceBudgetDeps,
  BudgetExceededDegrade,
  BudgetExceededHalt,
} from "@caliber/evaluator";
import type { GatewayMetrics } from "../../plugins/metrics.js";
import type { BudgetAlertEvent } from "./budgetAlertWebhook.js";

const WARNING_THRESHOLD = 0.8;

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Wrap `enforceBudget` with metric emission for budget warnings and breaches.
 * Returns a closure suitable for passing as the `enforceBudget` callback to
 * `callWithCostTracking`.
 */
export function wrapEnforceBudget(
  deps: EnforceBudgetDeps,
  metrics?: Pick<
    GatewayMetrics,
    "gwLlmBudgetWarnTotal" | "gwLlmBudgetExceededTotal"
  >,
  onBudgetEvent?: (e: BudgetAlertEvent) => void,
): (orgId: string, estimatedCost: number) => Promise<void> {
  return async (orgId, estimatedCost) => {
    try {
      await enforceBudget(orgId, estimatedCost, deps);

      // Soft warning: if the (post-allowance) month-to-date spend is already
      // >= 80% of budget, emit warn. We re-load to get the most current state
      // — `enforceBudget` doesn't surface either value, and a fresh read
      // tracks any concurrent ledger inserts that happened in parallel.
      const org = await deps.loadOrg(orgId);
      if (org.llm_monthly_budget_usd != null) {
        const monthSpend = await deps.getMonthSpend(
          orgId,
          monthStartUtc(deps.now()),
        );
        if (monthSpend >= org.llm_monthly_budget_usd * WARNING_THRESHOLD) {
          metrics?.gwLlmBudgetWarnTotal.inc({ org_id: orgId });
          onBudgetEvent?.({
            orgId,
            event: "warn",
            monthToDate: String(monthSpend),
            budget: String(org.llm_monthly_budget_usd),
          });
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededDegrade) {
        metrics?.gwLlmBudgetExceededTotal.inc({
          org_id: orgId,
          behavior: "degrade",
        });
        // The breach error carries the real numbers — surface them so the
        // webhook tells the operator how far over budget the org is.
        onBudgetEvent?.({
          orgId,
          event: "exceeded",
          monthToDate: String(err.currentSpend),
          budget: String(err.budget),
          behavior: "degrade",
        });
      } else if (err instanceof BudgetExceededHalt) {
        metrics?.gwLlmBudgetExceededTotal.inc({
          org_id: orgId,
          behavior: "halt",
        });
        onBudgetEvent?.({
          orgId,
          event: "exceeded",
          monthToDate: String(err.currentSpend),
          budget: String(err.budget),
          behavior: "halt",
        });
      }
      throw err;
    }
  };
}
