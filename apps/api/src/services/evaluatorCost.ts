import { and, eq, gte, lt, sum, count, desc, sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations, llmUsageEvents } from "@caliber/db";

export interface CostSummary {
  currentMonthSpendUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  projectedEndOfMonthUsd: number;
  breakdown: {
    facetExtraction: { calls: number; costUsd: number };
    deepAnalysis: { calls: number; costUsd: number };
  };
  breakdownByModel: Array<{ model: string; calls: number; costUsd: number }>;
  historicalMonths: Array<{ month: string; costUsd: number }>;
  warningThresholdReached: boolean;
  halted: boolean;
}

const WARNING_THRESHOLD = 0.8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthShift(d: Date, deltaMonths: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + deltaMonths, 1),
  );
}

function daysInMonth(d: Date): number {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

function elapsedDays(now: Date): number {
  const ms = now.getTime() - monthStartUtc(now).getTime();
  return Math.max(ms / MS_PER_DAY, 0.5);
}

function fmtMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

export async function getCostSummary(
  db: Database,
  orgId: string,
  now: Date = new Date(),
): Promise<CostSummary> {
  const mStart = monthStartUtc(now);
  const mEnd = monthShift(now, 1);
  const histStart = monthShift(now, -5);

  // Run the 4 read queries in parallel — none depend on each other and the
  // dashboard is the typical caller, so latency matters more than DB-load
  // smoothing.
  const [orgRows, byType, byModel, histRows] = await Promise.all([
    // 1. Org settings (budget + halted flag)
    db
      .select({
        budget: organizations.llmMonthlyBudgetUsd,
        halted: organizations.llmHaltedUntilMonthEnd,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),

    // 2. Breakdown by event_type for current month.
    db
      .select({
        eventType: llmUsageEvents.eventType,
        calls: count(),
        total: sum(llmUsageEvents.costUsd),
      })
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.orgId, orgId),
          gte(llmUsageEvents.createdAt, mStart),
          lt(llmUsageEvents.createdAt, mEnd),
        ),
      )
      .groupBy(llmUsageEvents.eventType),

    // 3. Breakdown by model for current month, sorted by total desc.
    db
      .select({
        model: llmUsageEvents.model,
        calls: count(),
        total: sum(llmUsageEvents.costUsd),
      })
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.orgId, orgId),
          gte(llmUsageEvents.createdAt, mStart),
          lt(llmUsageEvents.createdAt, mEnd),
        ),
      )
      .groupBy(llmUsageEvents.model)
      .orderBy(desc(sum(llmUsageEvents.costUsd))),

    // 4. Historical 6 months (including current).
    db.execute<{ month: string; total: string }>(sql`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(cost_usd), 0)::text AS total
      FROM llm_usage_events
      WHERE org_id = ${orgId}
        AND created_at >= ${histStart}
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const budget = orgRows[0]?.budget == null ? null : Number(orgRows[0].budget);
  const halted = orgRows[0]?.halted ?? false;

  const facet = byType.find((r) => r.eventType === "facet_extraction");
  const deep = byType.find((r) => r.eventType === "deep_analysis");
  const histByMonth = new Map<string, number>();
  for (const r of histRows.rows) {
    histByMonth.set(r.month, Number(r.total));
  }

  const historicalMonths: Array<{ month: string; costUsd: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const m = monthShift(now, -i);
    const key = fmtMonth(m);
    historicalMonths.push({ month: key, costUsd: histByMonth.get(key) ?? 0 });
  }

  // 5. Compose summary.
  const currentMonthSpendUsd = toNum(facet?.total) + toNum(deep?.total);
  const projectedEndOfMonthUsd =
    currentMonthSpendUsd * (daysInMonth(now) / elapsedDays(now));

  return {
    currentMonthSpendUsd,
    budgetUsd: budget,
    remainingUsd: budget == null ? null : budget - currentMonthSpendUsd,
    projectedEndOfMonthUsd,
    breakdown: {
      facetExtraction: {
        calls: toNum(facet?.calls),
        costUsd: toNum(facet?.total),
      },
      deepAnalysis: {
        calls: toNum(deep?.calls),
        costUsd: toNum(deep?.total),
      },
    },
    breakdownByModel: byModel.map((r) => ({
      model: r.model,
      calls: toNum(r.calls),
      costUsd: toNum(r.total),
    })),
    historicalMonths,
    warningThresholdReached:
      budget != null && currentMonthSpendUsd >= budget * WARNING_THRESHOLD,
    halted,
  };
}
