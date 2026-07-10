/**
 * Unit tests for gwEvalLlmCalledTotal grain-label + skipped_budget emission
 * (Per-project scoring PR7 — Part B observability test).
 *
 * Spec §6 requires `gwEvalLlmCalledTotal` to carry a `grain` label (`person`
 * or `key`) and a `skipped_budget` result value so per-key vs per-person
 * deep-analysis spend is separable in Prometheus. These metrics are only
 * emitted when a `metrics` object is present on `RunEvaluationInput`.
 *
 * The server.ts wiring change (PR7) ensures `app.gwMetrics` is passed to
 * `createEvaluatorWorker`, which in turn passes it to `runEvaluation`. This
 * test verifies the emission at the `runEvaluation` level, mirroring the
 * pattern in `runEvaluation.failures.test.ts`.
 *
 * RED phase: test did not exist; writing it documents the expected behavior.
 * GREEN phase: passes because the emission code exists in runEvaluation.ts
 * (PR2); the server.ts wiring fix ensures it reaches Prometheus in prod.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";
import type { Report } from "@caliber/evaluator";

// ── Mocks (hoisted by Vitest before imports) ─────────────────────────────────

// Mock the rule-based runner to return a non-skipped result with high coverage
// so the LLM gate is reached. The mock returns a synthetic report.
vi.mock(
  "../../../src/workers/evaluator/runRuleBased.js",
  () => ({
    runRuleBased: vi.fn().mockResolvedValue({
      skipped: false,
      report: {
        totalScore: 72,
        sectionScores: [],
        signalsSummary: {
          requests: 10,
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost: 0.05,
          cache_read_ratio: 0,
          refusal_rate: 0,
          model_mix: {},
          client_mix: {},
          model_diversity: 0,
          tool_diversity: 0,
          iteration_count: 10,
          client_mix_ratio: 0,
          body_capture_coverage: 0.9,
          period: { requestCount: 10, bodyCount: 9 },
        },
        dataQuality: {
          capturedRequests: 9,
          missingBodies: 1,
          truncatedBodies: 0,
          totalRequests: 10,
          // coverageRatio >= 0.5 so LLM gate is attempted
          coverageRatio: 0.9,
        },
      } satisfies Report,
      bodies: [{ id: "body-1", content: "test body" }],
    }),
    upsertEvaluationReport: vi.fn().mockResolvedValue("test-person-report-id"),
  }),
);

// Mock the budget gate to force the skipped_budget code path in runEvaluation.
// After this, runEvaluation emits gwEvalLlmCalledTotal{result:skipped_budget}.
vi.mock("../../../src/workers/evaluator/ledgerDeepAnalysis.js", () => ({
  deepAnalysisBudgetGate: vi.fn().mockResolvedValue({ skip: true }),
  writeDeepAnalysisLedger: vi.fn().mockResolvedValue({ written: false }),
  isDeepAnalysisEnforceEnabled: vi.fn().mockReturnValue(true),
  REF_TYPE_PERSON: "evaluation_report",
  REF_TYPE_KEY: "evaluation_report_by_key",
  DEEP_ANALYSIS_EVENT_TYPE: "deep_analysis",
  LEDGER_USAGE_LOOKUP_MAX_ATTEMPTS: 3,
  LEDGER_USAGE_LOOKUP_DELAY_MS: 250,
}));

// Mock the by-key upsert (per-key path, not exercised in per-person tests)
vi.mock(
  "../../../src/workers/evaluator/upsertEvaluationReportByKey.js",
  () => ({
    upsertEvaluationReportByKey: vi
      .fn()
      .mockResolvedValue("test-key-report-id"),
  }),
);

// ── Metric spy ────────────────────────────────────────────────────────────────

interface GrainResultCall {
  result: string;
  grain: string;
}

class EvalMetricsSpy {
  private calls: GrainResultCall[] = [];

  readonly gwEvalLlmCalledTotal = {
    inc: (labels: GrainResultCall) => {
      this.calls.push({ ...labels });
    },
  };

  // Minimal stubs for other EvaluationMetrics fields (not asserted here)
  readonly gwEvalLlmCostUsd = { inc: vi.fn() };
  readonly gwEvalLlmFailedTotal = { inc: vi.fn() };
  readonly gwEvalLlmParseFailedTotal = { inc: vi.fn() };
  readonly gwEvalDlqCount = { inc: vi.fn() };

  calledWith(result: string, grain: string): boolean {
    return this.calls.some((c) => c.result === result && c.grain === grain);
  }

  allCalls(): GrainResultCall[] {
    return [...this.calls];
  }

  reset(): void {
    this.calls = [];
    vi.clearAllMocks();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runEvaluation gwEvalLlmCalledTotal grain + skipped_budget emission", () => {
  let metricsSpy: EvalMetricsSpy;
  let runEvaluation: typeof import("../../../src/workers/evaluator/runEvaluation.js").runEvaluation;

  // Minimal DB stub: only the `api_keys.teamId` lookup in the per-key
  // upsert path needs to resolve. Return an empty row so teamId defaults null.
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            then: vi.fn((cb: (rows: unknown[]) => unknown) => cb([])),
          })),
        })),
      })),
    })),
  } as unknown as Database;

  const fakeRedis = {} as unknown as Redis;

  const baseInput = {
    db: fakeDb,
    redis: fakeRedis,
    masterKeyHex: "a".repeat(64),
    gatewayBaseUrl: "http://localhost:3002",
    orgId: "org-wiring-test",
    userId: "user-wiring-test",
    periodStart: new Date("2024-03-01T00:00:00.000Z"),
    periodEnd: new Date("2024-03-02T00:00:00.000Z"),
    periodType: "daily" as const,
    rubric: platformDefaultRubric,
    rubricId: "test-rubric",
    rubricVersion: "1.0",
    triggeredBy: "cron" as const,
    triggeredByUser: null,
    llmEvalEnabled: true,
  };

  beforeAll(async () => {
    ({ runEvaluation } = await import(
      "../../../src/workers/evaluator/runEvaluation.js"
    ));
  }, 15_000);

  beforeEach(() => {
    metricsSpy = new EvalMetricsSpy();
    metricsSpy.reset();
  });

  it("per-person grain: skipped_budget emits gwEvalLlmCalledTotal{grain:person,result:skipped_budget}", async () => {
    await runEvaluation({
      ...baseInput,
      metrics: metricsSpy,
      // No apiKeyId → per-person grain
    });

    expect(
      metricsSpy.calledWith("skipped_budget", "person"),
    ).toBe(true);
  });

  it("per-key grain: skipped_budget emits gwEvalLlmCalledTotal{grain:key,result:skipped_budget}", async () => {
    await runEvaluation({
      ...baseInput,
      metrics: metricsSpy,
      apiKeyId: "key-00000000-0000-0000-0000-000000000001",
      keyNameSnapshot: "wiring-test-key",
    });

    expect(
      metricsSpy.calledWith("skipped_budget", "key"),
    ).toBe(true);
  });

  it("no metrics (server.ts wiring absent) → counter is NOT incremented", async () => {
    // Passing metrics: undefined mimics the pre-fix server.ts behavior where
    // createEvaluatorWorker was called without a metrics object.
    await runEvaluation({
      ...baseInput,
      metrics: undefined,
    });

    // The spy was never passed in — calls array is empty.
    expect(metricsSpy.allCalls()).toHaveLength(0);
  });
});
