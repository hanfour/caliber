/**
 * Unit tests for `wrapEnforceBudget` (Plan 4C, Part 7).
 *
 * Pure unit tests — no DB. Stubs `EnforceBudgetDeps` and the metric counters
 * with `vi.fn()` to assert label/value emission directly.
 *
 * Cases covered:
 *   1. Happy path under 80% threshold       → no warn, no exceeded.
 *   2. Happy path at >=80% threshold        → warn +1.
 *   3. `BudgetExceededDegrade` thrown       → exceeded{behavior=degrade} +1, rethrows.
 *   4. `BudgetExceededHalt` thrown          → exceeded{behavior=halt} +1, rethrows.
 *   5. NULL budget                          → no warn (threshold requires budget).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BudgetExceededDegrade,
  BudgetExceededHalt,
  type EnforceBudgetDeps,
  type OrgBudgetState,
} from "@caliber/evaluator";
import { wrapEnforceBudget } from "../../../src/workers/evaluator/enforceBudgetWithMetrics.js";

interface MetricStub {
  inc: ReturnType<typeof vi.fn>;
}

interface MetricsStub {
  gwLlmBudgetWarnTotal: MetricStub;
  gwLlmBudgetExceededTotal: MetricStub;
}

function makeMetrics(): MetricsStub {
  return {
    gwLlmBudgetWarnTotal: { inc: vi.fn() },
    gwLlmBudgetExceededTotal: { inc: vi.fn() },
  };
}

interface DepsConfig {
  budget: number | null;
  monthSpend: number;
  behavior?: "degrade" | "halt";
  halted?: boolean;
  haltSetAt?: Date;
  now?: Date;
}

const FIXED_NOW = new Date(Date.UTC(2026, 3, 15, 12, 0, 0)); // April 15 2026

function makeDeps(cfg: DepsConfig): EnforceBudgetDeps {
  const org: OrgBudgetState = {
    id: "org-1",
    llm_monthly_budget_usd: cfg.budget,
    llm_budget_overage_behavior: cfg.behavior ?? "degrade",
    llm_halted_until_month_end: cfg.halted ?? false,
    halt_set_at: cfg.haltSetAt,
  };
  return {
    loadOrg: vi.fn(async () => org),
    getMonthSpend: vi.fn(async () => cfg.monthSpend),
    setHalt: vi.fn(async () => {}),
    clearHalt: vi.fn(async () => {}),
    now: () => cfg.now ?? FIXED_NOW,
  };
}

describe("wrapEnforceBudget", () => {
  let metrics: MetricsStub;

  beforeEach(() => {
    metrics = makeMetrics();
  });

  it("happy path under 80% threshold emits no metrics", async () => {
    // budget=100, spend=50 → 50% of budget — under threshold
    const deps = makeDeps({ budget: 100, monthSpend: 50 });
    // metric stubs are typed as `any` here because `Pick<GatewayMetrics, ...>`
    // expects full prom-client Counter types; we only exercise `.inc`.
    const wrapped = wrapEnforceBudget(deps, metrics as never);

    await expect(wrapped("org-1", 5)).resolves.toBeUndefined();
    expect(metrics.gwLlmBudgetWarnTotal.inc).not.toHaveBeenCalled();
    expect(metrics.gwLlmBudgetExceededTotal.inc).not.toHaveBeenCalled();
  });

  it("happy path at >=80% threshold emits warn once", async () => {
    // budget=100, spend=85 → 85% of budget — above threshold
    const deps = makeDeps({ budget: 100, monthSpend: 85 });
    const wrapped = wrapEnforceBudget(deps, metrics as never);

    await expect(wrapped("org-1", 1)).resolves.toBeUndefined();
    expect(metrics.gwLlmBudgetWarnTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.gwLlmBudgetWarnTotal.inc).toHaveBeenCalledWith({
      org_id: "org-1",
    });
    expect(metrics.gwLlmBudgetExceededTotal.inc).not.toHaveBeenCalled();
  });

  it("emits exceeded{behavior=degrade} and rethrows on BudgetExceededDegrade", async () => {
    // budget=100, spend=99, est=10 → 109 > 100, behavior=degrade
    const deps = makeDeps({
      budget: 100,
      monthSpend: 99,
      behavior: "degrade",
    });
    const wrapped = wrapEnforceBudget(deps, metrics as never);

    await expect(wrapped("org-1", 10)).rejects.toBeInstanceOf(
      BudgetExceededDegrade,
    );
    expect(metrics.gwLlmBudgetExceededTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.gwLlmBudgetExceededTotal.inc).toHaveBeenCalledWith({
      org_id: "org-1",
      behavior: "degrade",
    });
    expect(metrics.gwLlmBudgetWarnTotal.inc).not.toHaveBeenCalled();
  });

  it("emits exceeded{behavior=halt} and rethrows on BudgetExceededHalt", async () => {
    // budget=100, spend=99, est=10 → 109 > 100, behavior=halt
    const deps = makeDeps({ budget: 100, monthSpend: 99, behavior: "halt" });
    const wrapped = wrapEnforceBudget(deps, metrics as never);

    await expect(wrapped("org-1", 10)).rejects.toBeInstanceOf(
      BudgetExceededHalt,
    );
    expect(metrics.gwLlmBudgetExceededTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.gwLlmBudgetExceededTotal.inc).toHaveBeenCalledWith({
      org_id: "org-1",
      behavior: "halt",
    });
    expect(metrics.gwLlmBudgetWarnTotal.inc).not.toHaveBeenCalled();
  });

  it("emits no warn metric when budget is NULL (unlimited)", async () => {
    // null budget → enforceBudget short-circuits as unlimited; threshold
    // check requires a finite budget so warn must stay at zero.
    const deps = makeDeps({ budget: null, monthSpend: 1_000_000 });
    const wrapped = wrapEnforceBudget(deps, metrics as never);

    await expect(wrapped("org-1", 50)).resolves.toBeUndefined();
    expect(metrics.gwLlmBudgetWarnTotal.inc).not.toHaveBeenCalled();
    expect(metrics.gwLlmBudgetExceededTotal.inc).not.toHaveBeenCalled();
  });
});
