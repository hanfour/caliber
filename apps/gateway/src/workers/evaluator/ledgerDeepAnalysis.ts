/**
 * Deep-analysis budget gate + ledger writer (Per-project scoring PR2).
 *
 * Closes the verified spend-blind gap: today `runLlm.ts` (deep analysis)
 * calls NEITHER `enforceBudget` NOR any ledger write, so its spend is
 * invisible (never raises `getMonthSpend`) and unhaltable. This module adds:
 *
 *   1. `deepAnalysisBudgetGate` — a PRE-call halt-state check. Before the
 *      loopback LLM call, if the org's month-to-date spend already meets/exceeds
 *      its monthly budget, skip the LLM and fall back to rule-based scoring.
 *      Reuses the exact `enforceBudget` halt/degrade machinery that facet
 *      extraction uses (so deep analysis participates in the same halt flag).
 *      Deep-analysis cost is only known *after* the call, so we enforce with a
 *      zero pre-estimate (a halt-state check, not an inaccurate pre-charge).
 *
 *   2. `writeDeepAnalysisLedger` — a POST-call ledger write. Recovers the real
 *      `tokens_input` / `tokens_output` / `cost_usd` from the loopback
 *      `usage_logs` row the call produced (NOT-NULL columns — never a
 *      placeholder), and writes ONE `llm_usage_events` row with
 *      `onConflictDoNothing` against the `llm_usage_dedup_idx` partial unique
 *      index so BullMQ retries (attempts=3) cannot double-count.
 *
 * Honest-accounting contract (spec §6): the ledger row is written
 * UNCONDITIONALLY on success. The `EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS`
 * kill-switch (default on) disables only the pre-call *enforcement* (the skip),
 * never the ledger write.
 *
 * Grain: this PR only wires the per-person grain (`grain:"person"`,
 * `refType=evaluation_report`). The writer takes `refType` as a parameter so
 * PR3 can pass the per-key variant (`evaluation_report_by_key`) without
 * touching this code. See spec §6.
 */

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { llmUsageEvents, usageLogs } from "@caliber/db";
import {
  enforceBudget as enforceBudgetCore,
  isBudgetError,
} from "@caliber/evaluator";
import type { GatewayMetrics } from "../../plugins/metrics.js";
import type { BudgetAlertEvent } from "./budgetAlertWebhook.js";
import { createBudgetDeps } from "./budgetDeps.js";
import { wrapEnforceBudget } from "./enforceBudgetWithMetrics.js";

// ── Shared constants (never inline these at the call site) ───────────────────

/** `llm_usage_events.event_type` value for the deep-analysis LLM step. */
export const DEEP_ANALYSIS_EVENT_TYPE = "deep_analysis" as const;

/** `ref_type` for the per-person grain (this PR). */
export const REF_TYPE_PERSON = "evaluation_report" as const;

/** `ref_type` for the per-key grain (wired in PR3; declared now for reuse). */
export const REF_TYPE_KEY = "evaluation_report_by_key" as const;

export type DeepAnalysisRefType =
  | typeof REF_TYPE_PERSON
  | typeof REF_TYPE_KEY;

/**
 * Resolve the deep-analysis enforcement kill-switch from the environment.
 * Default ON (`true`) — only the literal string `"false"` disables it. The
 * worker reads `process.env` directly (matching `ENABLE_FACET_EXTRACTION`);
 * `@caliber/config` declares + documents the same flag with `default(true)`.
 */
export function isDeepAnalysisEnforceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS !== "false";
}

// ── Budget gate ──────────────────────────────────────────────────────────────

type BudgetGateMetrics = Pick<
  GatewayMetrics,
  "gwLlmBudgetWarnTotal" | "gwLlmBudgetExceededTotal"
>;

export interface DeepAnalysisBudgetGateInput {
  db: Database;
  orgId: string;
  /** When false the gate never skips (kill-switch disables enforcement). */
  enforce: boolean;
  /** Optional — surfaces budget warn/exceeded counters (same as facet path). */
  metrics?: BudgetGateMetrics;
  /** Optional sink for budget warn/exceeded webhook alerts (Plan P4). */
  onBudgetEvent?: (e: BudgetAlertEvent) => void;
}

export interface DeepAnalysisBudgetGateResult {
  /** True → skip the deep-analysis LLM call, fall back to rule-based. */
  skip: boolean;
}

/**
 * Pre-call halt-state check. Returns `{ skip: true }` only when enforcement is
 * on AND the org is over budget (or already halted this month). Fail-soft: any
 * unexpected budget-infra error falls open (`skip:false`) to preserve the prior
 * per-person behavior (deep analysis always ran before this PR).
 */
export async function deepAnalysisBudgetGate(
  input: DeepAnalysisBudgetGateInput,
): Promise<DeepAnalysisBudgetGateResult> {
  if (!input.enforce) {
    return { skip: false };
  }

  const deps = createBudgetDeps(input.db);
  const enforce = input.metrics
    ? wrapEnforceBudget(deps, input.metrics, input.onBudgetEvent)
    : (orgId: string, est: number) => enforceBudgetCore(orgId, est, deps);

  try {
    // Zero pre-estimate: deep-analysis cost is only known post-call, so this is
    // a halt-state check (skip if ALREADY over budget), not a pre-charge.
    await enforce(input.orgId, 0);
    return { skip: false };
  } catch (err) {
    if (isBudgetError(err)) {
      return { skip: true };
    }
    // Unexpected error (e.g. org row missing, transient DB) → fall open.
    return { skip: false };
  }
}

// ── Ledger writer ─────────────────────────────────────────────────────────────

/** How many times to poll usage_logs for the loopback row to materialize. */
export const LEDGER_USAGE_LOOKUP_MAX_ATTEMPTS = 3;
/** Delay between usage_logs lookup attempts (ms). */
export const LEDGER_USAGE_LOOKUP_DELAY_MS = 250;

export interface WriteDeepAnalysisLedgerInput {
  db: Database;
  orgId: string;
  /** The just-upserted report id — used as `ref_id` (must already exist). */
  reportId: string;
  /** Grain selector: per-person (this PR) or per-key (PR3). */
  refType: DeepAnalysisRefType;
  /** X-Request-Id of the loopback deep-analysis call (the usage_logs key). */
  usageLogRequestId: string;
  /** Optional — increments gwLlmCostUsdTotal on a successful insert. */
  metrics?: Pick<GatewayMetrics, "gwLlmCostUsdTotal">;
  /** Test injection — overrides the materialization-wait sleep. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface WriteDeepAnalysisLedgerResult {
  /** True if a NEW ledger row was inserted; false on dedup conflict or missing usage_log. */
  written: boolean;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
}

/**
 * Recover the real token counts + cost from the loopback `usage_logs` row and
 * write ONE `llm_usage_events` ledger row, idempotently.
 *
 * - SELECTs `input_tokens`, `output_tokens`, `total_cost`, `requested_model`
 *   from `usage_logs` by `requestId` (polls a few times in case the async
 *   usage-log persist hasn't landed yet).
 * - If the row never materializes → returns `{ written: false }` and writes
 *   NOTHING (the NOT-NULL token columns cannot be honestly satisfied; we never
 *   write a 0/placeholder).
 * - INSERT uses `onConflictDoNothing` targeting the partial unique index
 *   `llm_usage_dedup_idx (ref_type, ref_id, event_type) WHERE ref_id IS NOT
 *   NULL`, so a BullMQ retry that re-runs the whole job cannot double-count.
 */
export async function writeDeepAnalysisLedger(
  input: WriteDeepAnalysisLedgerInput,
): Promise<WriteDeepAnalysisLedgerResult> {
  const sleep =
    input.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Recover NOT-NULL ledger inputs from the loopback usage_log row.
  let recovered:
    | {
        tokensInput: number;
        tokensOutput: number;
        totalCost: string;
        model: string;
      }
    | undefined;

  for (let i = 0; i < LEDGER_USAGE_LOOKUP_MAX_ATTEMPTS; i++) {
    const row = await input.db
      .select({
        inputTokens: usageLogs.inputTokens,
        outputTokens: usageLogs.outputTokens,
        totalCost: usageLogs.totalCost,
        requestedModel: usageLogs.requestedModel,
      })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, input.usageLogRequestId))
      .limit(1)
      .then((r) => r[0]);

    if (row) {
      recovered = {
        tokensInput: row.inputTokens,
        tokensOutput: row.outputTokens,
        totalCost: row.totalCost,
        model: row.requestedModel,
      };
      break;
    }
    if (i < LEDGER_USAGE_LOOKUP_MAX_ATTEMPTS - 1) {
      await sleep(LEDGER_USAGE_LOOKUP_DELAY_MS);
    }
  }

  if (!recovered) {
    // Cannot honestly ledger without real token counts (NOT-NULL columns).
    return { written: false };
  }

  const costUsd = Number(recovered.totalCost);

  const inserted = await input.db
    .insert(llmUsageEvents)
    .values({
      orgId: input.orgId,
      eventType: DEEP_ANALYSIS_EVENT_TYPE,
      model: recovered.model,
      tokensInput: recovered.tokensInput,
      tokensOutput: recovered.tokensOutput,
      // decimal column accepts a string in Drizzle; keep full precision and
      // let Postgres round to the column scale.
      costUsd: recovered.totalCost,
      refType: input.refType,
      refId: input.reportId,
    })
    .onConflictDoNothing({
      target: [
        llmUsageEvents.refType,
        llmUsageEvents.refId,
        llmUsageEvents.eventType,
      ],
      where: sql`${llmUsageEvents.refId} IS NOT NULL`,
    })
    .returning({ id: llmUsageEvents.id });

  const written = inserted.length > 0;

  if (written) {
    input.metrics?.gwLlmCostUsdTotal.inc(
      {
        org_id: input.orgId,
        event_type: DEEP_ANALYSIS_EVENT_TYPE,
        model: recovered.model,
      },
      costUsd,
    );
  }

  return {
    written,
    tokensInput: recovered.tokensInput,
    tokensOutput: recovered.tokensOutput,
    costUsd,
  };
}
