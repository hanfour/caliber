/**
 * Concrete budget deps for the gateway evaluator worker
 * (Plan 4C, Task 3.2; halt_set_at column added in follow-up #6).
 *
 * Wires the abstract `EnforceBudgetDeps` interface from `@caliber/evaluator` to
 * a real Drizzle/Postgres `Database`, so the worker can call `enforceBudget`
 * with production storage.
 *
 * Wiring:
 *   - loadOrg       → SELECT from `organizations` (snake_case shape)
 *   - getMonthSpend → SUM(`cost_usd`) from `llm_usage_events` for the org
 *                     where monthStart <= created_at < nextMonthStart
 *                     (upper bound prevents leaking future-month rows; defensive)
 *   - setHalt       → UPDATE … SET llm_halted_until_month_end = true,
 *                                  llm_halted_at = now()
 *   - clearHalt     → UPDATE … SET llm_halted_until_month_end = false,
 *                                  llm_halted_at = NULL
 *   - now           → wall clock
 *
 * `halt_set_at` is sourced from `organizations.llm_halted_at`. With it
 * present, `enforceBudget`'s same-month check short-circuits cheaply for
 * already-halted orgs (1 SELECT) instead of doing 2 UPDATEs per call.
 */

import { and, eq, gte, lt, sum } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { llmUsageEvents, organizations } from "@caliber/db";
import type { EnforceBudgetDeps } from "@caliber/evaluator";

const DEFAULT_OVERAGE_BEHAVIOR = "degrade" as const;

/**
 * Build a concrete `EnforceBudgetDeps` bound to the given Drizzle `Database`.
 *
 * The returned deps object is itself immutable — callers should not mutate
 * its members. Each call creates a fresh closure over `db`.
 */
export function createBudgetDeps(db: Database): EnforceBudgetDeps {
  return {
    async loadOrg(orgId) {
      const rows = await db
        .select({
          id: organizations.id,
          llmMonthlyBudgetUsd: organizations.llmMonthlyBudgetUsd,
          llmBudgetOverageBehavior: organizations.llmBudgetOverageBehavior,
          llmHaltedUntilMonthEnd: organizations.llmHaltedUntilMonthEnd,
          llmHaltedAt: organizations.llmHaltedAt,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new Error(`Org not found: ${orgId}`);
      }

      const behavior =
        row.llmBudgetOverageBehavior === "halt"
          ? "halt"
          : DEFAULT_OVERAGE_BEHAVIOR;

      return {
        id: row.id,
        llm_monthly_budget_usd:
          row.llmMonthlyBudgetUsd == null
            ? null
            : Number(row.llmMonthlyBudgetUsd),
        llm_budget_overage_behavior: behavior,
        llm_halted_until_month_end: row.llmHaltedUntilMonthEnd,
        halt_set_at: row.llmHaltedAt ?? undefined,
      };
    },

    async getMonthSpend(orgId, monthStart) {
      // Compute the start of the *next* UTC month to use as an exclusive upper
      // bound. Without this bound, a clock-skewed or backfilled future row
      // would inflate the current month's spend.
      const nextMonthStart = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
      );

      const rows = await db
        .select({ total: sum(llmUsageEvents.costUsd) })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.orgId, orgId),
            gte(llmUsageEvents.createdAt, monthStart),
            lt(llmUsageEvents.createdAt, nextMonthStart),
          ),
        );

      const total = rows[0]?.total;
      if (total == null) {
        return 0;
      }
      const parsed = Number(total);
      return Number.isFinite(parsed) ? parsed : 0;
    },

    async setHalt(orgId) {
      await db
        .update(organizations)
        .set({
          llmHaltedUntilMonthEnd: true,
          llmHaltedAt: new Date(),
        })
        .where(eq(organizations.id, orgId));
    },

    async clearHalt(orgId) {
      await db
        .update(organizations)
        .set({
          llmHaltedUntilMonthEnd: false,
          llmHaltedAt: null,
        })
        .where(eq(organizations.id, orgId));
    },

    now: () => new Date(),
  };
}
