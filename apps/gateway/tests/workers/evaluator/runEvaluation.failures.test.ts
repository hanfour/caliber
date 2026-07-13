/**
 * Unit tests for metric emission in runLlm (Plan 4B Part 5, Task 5.4).
 *
 * Focuses on verifying metric emissions at specific LLM failure paths.
 *
 * Note: Full fetch/parse error testing is done in integration tests since
 * those paths require complex database mocking. These tests focus on the
 * simpler paths that can be tested in isolation.
 *
 * Test cases:
 *   1. Missing Redis key → missing_key metric
 *   2. LLM disabled → disabled metric
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import * as RealRunLlm from "../../../src/workers/evaluator/runLlm.js";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";
import type { Report } from "@caliber/evaluator";

// ── Metric Spy / Recorder ────────────────────────────────────────────────────

class MetricsSpy {
  calls: Array<{ method: string; reason?: string }> = [];

  gwEvalLlmFailedTotal = {
    inc: (labels: { reason: string }) => {
      this.calls.push({
        method: "gwEvalLlmFailedTotal.inc",
        reason: labels.reason,
      });
    },
  };

  gwEvalLlmParseFailedTotal = {
    inc: () => {
      this.calls.push({
        method: "gwEvalLlmParseFailedTotal.inc",
      });
    },
  };

  assertEmitted(method: string, reason?: string) {
    const found = this.calls.find(
      (c) =>
        c.method === method && (reason === undefined || c.reason === reason),
    );
    expect(found).toBeDefined();
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("runLlmDeepAnalysis metric emission", () => {
  let metrics: MetricsSpy;

  beforeEach(() => {
    metrics = new MetricsSpy();
  });

  // ── Test 1: Missing Redis key ────────────────────────────────────────────

  it("should emit missing_key when Redis key not found", async () => {
    const fakeRedis = {
      get: vi.fn(async () => null),
    } as unknown as Redis;

    const fakeDb = {} as unknown as Database;
    const report: Report = {
      totalScore: 80,
      insufficientData: false,
      sectionScores: [],
      signalsSummary: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        cache_read_ratio: 0,
        refusal_rate: 0,
        model_mix: {},
        client_mix: {},
        model_diversity: 0,
        tool_diversity: 0,
        iteration_count: 0,
        client_mix_ratio: 0,
        body_capture_coverage: 0.9,
        period: { requestCount: 0, bodyCount: 0 },
      },
      dataQuality: {
        capturedRequests: 9,
        missingBodies: 1,
        truncatedBodies: 0,
        totalRequests: 10,
        coverageRatio: 0.9,
      },
    };

    const result = await RealRunLlm.runLlmDeepAnalysis({
      db: fakeDb,
      redis: fakeRedis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "test-org",
      rubric: platformDefaultRubric,
      ruleBasedReport: report,
      bodies: [],
      metrics,
      sleepMs: async () => {},
    });

    expect(result).toBeNull();
    metrics.assertEmitted("gwEvalLlmFailedTotal.inc", "missing_key");
  });

  // ── Test 2: LLM disabled ─────────────────────────────────────────────────

  it("should emit disabled when org.llmEvalEnabled=false", async () => {
    const fakeRedis = {
      get: vi.fn(async () => "test-key"),
    } as unknown as Redis;

    const fakeDb = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: async (cb: (v: unknown[]) => unknown) => {
                return cb([
                  { llmEvalEnabled: false, llmEvalModel: "claude-haiku-4-5" },
                ]);
              },
            }),
          }),
        }),
      })),
    } as unknown as Database;

    const report: Report = {
      totalScore: 80,
      insufficientData: false,
      sectionScores: [],
      signalsSummary: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        cache_read_ratio: 0,
        refusal_rate: 0,
        model_mix: {},
        client_mix: {},
        model_diversity: 0,
        tool_diversity: 0,
        iteration_count: 0,
        client_mix_ratio: 0,
        body_capture_coverage: 0.9,
        period: { requestCount: 0, bodyCount: 0 },
      },
      dataQuality: {
        capturedRequests: 9,
        missingBodies: 1,
        truncatedBodies: 0,
        totalRequests: 10,
        coverageRatio: 0.9,
      },
    };

    const result = await RealRunLlm.runLlmDeepAnalysis({
      db: fakeDb,
      redis: fakeRedis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "test-org",
      rubric: platformDefaultRubric,
      ruleBasedReport: report,
      bodies: [],
      metrics,
      sleepMs: async () => {},
    });

    expect(result).toBeNull();
    metrics.assertEmitted("gwEvalLlmFailedTotal.inc", "disabled");
  });

  // Helper: creates a chainable Drizzle-like mock that resolves on .then()
  function mkDbReturning<T>(rows: T[]): Database {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "from", "where", "limit"]) {
      chain[method] = () => chain;
    }
    chain.then = (cb: (v: T[]) => unknown) => Promise.resolve(cb(rows));
    return chain as unknown as Database;
  }

  // ── Test 3: Fetch error ──────────────────────────────────────────────────

  it("should emit fetch_error when fetch throws", async () => {
    const fakeRedis = {
      get: vi.fn(async () => "test-key"),
    } as unknown as Redis;

    const fakeDb = mkDbReturning([
      { llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5" },
    ]);

    const fakeFetch = vi.fn(async () => {
      throw new Error("network down");
    });

    const report: Report = {
      totalScore: 80,
      insufficientData: false,
      sectionScores: [],
      signalsSummary: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        cache_read_ratio: 0,
        refusal_rate: 0,
        model_mix: {},
        client_mix: {},
        model_diversity: 0,
        tool_diversity: 0,
        iteration_count: 0,
        client_mix_ratio: 0,
        body_capture_coverage: 0.9,
        period: { requestCount: 0, bodyCount: 0 },
      },
      dataQuality: {
        capturedRequests: 9,
        missingBodies: 1,
        truncatedBodies: 0,
        totalRequests: 10,
        coverageRatio: 0.9,
      },
    };

    const result = await RealRunLlm.runLlmDeepAnalysis({
      db: fakeDb,
      redis: fakeRedis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "test-org",
      rubric: platformDefaultRubric,
      ruleBasedReport: report,
      bodies: [],
      metrics,
      fetchImpl: fakeFetch,
      sleepMs: async () => {},
    });

    expect(result).toBeNull();
    metrics.assertEmitted("gwEvalLlmFailedTotal.inc", "fetch_error");
  });

  // ── Test 4: Fetch non-2xx ────────────────────────────────────────────────

  it("should emit fetch_non_2xx when fetch returns non-2xx", async () => {
    const fakeRedis = {
      get: vi.fn(async () => "test-key"),
    } as unknown as Redis;

    const fakeDb = mkDbReturning([
      { llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5" },
    ]);

    const fakeFetch = vi.fn(async () => {
      const headers = new Headers();
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ error: "service unavailable" }), {
        status: 503,
        headers,
      });
    });

    const report: Report = {
      totalScore: 80,
      insufficientData: false,
      sectionScores: [],
      signalsSummary: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        cache_read_ratio: 0,
        refusal_rate: 0,
        model_mix: {},
        client_mix: {},
        model_diversity: 0,
        tool_diversity: 0,
        iteration_count: 0,
        client_mix_ratio: 0,
        body_capture_coverage: 0.9,
        period: { requestCount: 0, bodyCount: 0 },
      },
      dataQuality: {
        capturedRequests: 9,
        missingBodies: 1,
        truncatedBodies: 0,
        totalRequests: 10,
        coverageRatio: 0.9,
      },
    };

    const result = await RealRunLlm.runLlmDeepAnalysis({
      db: fakeDb,
      redis: fakeRedis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "test-org",
      rubric: platformDefaultRubric,
      ruleBasedReport: report,
      bodies: [],
      metrics,
      fetchImpl: fakeFetch,
      sleepMs: async () => {},
    });

    expect(result).toBeNull();
    metrics.assertEmitted("gwEvalLlmFailedTotal.inc", "fetch_non_2xx");
  });

  // ── Test 5: Parse error ──────────────────────────────────────────────────

  it("should emit parse_error + gwEvalLlmParseFailedTotal when response fails validation", async () => {
    const fakeRedis = {
      get: vi.fn(async () => "test-key"),
    } as unknown as Redis;

    const fakeDb = mkDbReturning([
      { llmEvalEnabled: true, llmEvalModel: "claude-haiku-4-5" },
    ]);

    const fakeFetch = vi.fn(async () => {
      const body = { content: [{ type: "text", text: "not valid JSON" }] };
      const headers = new Headers();
      headers.set("x-request-id", "req-1");
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers,
      });
    });

    const report: Report = {
      totalScore: 80,
      insufficientData: false,
      sectionScores: [],
      signalsSummary: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0,
        cache_read_ratio: 0,
        refusal_rate: 0,
        model_mix: {},
        client_mix: {},
        model_diversity: 0,
        tool_diversity: 0,
        iteration_count: 0,
        client_mix_ratio: 0,
        body_capture_coverage: 0.9,
        period: { requestCount: 0, bodyCount: 0 },
      },
      dataQuality: {
        capturedRequests: 9,
        missingBodies: 1,
        truncatedBodies: 0,
        totalRequests: 10,
        coverageRatio: 0.9,
      },
    };

    const result = await RealRunLlm.runLlmDeepAnalysis({
      db: fakeDb,
      redis: fakeRedis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId: "test-org",
      rubric: platformDefaultRubric,
      ruleBasedReport: report,
      bodies: [],
      metrics,
      fetchImpl: fakeFetch,
      sleepMs: async () => {},
    });

    expect(result).toBeNull();
    metrics.assertEmitted("gwEvalLlmFailedTotal.inc", "parse_error");
    metrics.assertEmitted("gwEvalLlmParseFailedTotal.inc");
  });
});
