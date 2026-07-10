/**
 * Unit tests for `runtime/usageLogging.ts` — the shared helper that both
 * non-streaming routes call to build + enqueue usage-log payloads (Plan 4A
 * Part 7, Sub-task B).
 *
 * Covers:
 *   - Token extraction from well-formed / malformed upstream bodies
 *   - Cost computation + decimal string formatting (scale 10)
 *   - Pricing-miss path: counter bump, zeroed costs, still enqueues
 *   - Enqueue wiring passes fallback { db, logger, metrics }
 *   - Test-mode short-circuit when `app.usageLogQueue` is undefined
 *   - Residual enqueue errors do not propagate (never fail user request)
 *   - Payload shape (platform/surface, streaming-only fields null, etc.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildUsageLogPayload,
  emitUsageLog,
  extractUsageFromAnthropicResponse,
  getPricing,
  resetPricingCacheForTests,
} from "../../src/runtime/usageLogging.js";
import type { UsageLogJobPayload } from "../../src/workers/usageLogQueue.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_UUID_ORG = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_USER = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_KEY = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_ACCT = "44444444-4444-4444-8444-444444444444";
const VALID_UUID_TEAM = "55555555-5555-4555-8555-555555555555";

function makeReq(
  overrides: Partial<{
    id: string;
    headers: Record<string, string | undefined>;
    ip: string;
    teamId: string | null;
    gwGroupContext: Record<string, unknown> | null;
  }> = {},
): FastifyRequest {
  // Minimum viable FastifyRequest for the helper. Everything the helper
  // reads is narrowly scoped (id, headers, ip, apiKey, gwUser, log) —
  // typing as `unknown as FastifyRequest` keeps the cast narrow.
  const req = {
    id: overrides.id ?? "req-test-1",
    headers: overrides.headers ?? { "user-agent": "vitest/1.0" },
    ip: overrides.ip ?? "127.0.0.1",
    apiKey: {
      id: VALID_UUID_KEY,
      orgId: VALID_UUID_ORG,
      userId: VALID_UUID_USER,
      teamId: overrides.teamId !== undefined ? overrides.teamId : null,
      quotaUsd: "0",
      quotaUsedUsd: "0",
    },
    gwUser: { id: VALID_UUID_USER, email: "test@example.com" },
    gwOrg: { id: VALID_UUID_ORG, slug: "test-org" },
    gwGroupContext: overrides.gwGroupContext ?? null,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  return req as unknown as FastifyRequest;
}

function makeApp(
  overrides: Partial<{
    usageLogQueue: FastifyInstance["usageLogQueue"] | undefined;
    db: unknown;
  }> = {},
): FastifyInstance {
  const pricingMissInc = vi.fn();
  const persistLostInc = vi.fn();
  const upstreamDurationObserve = vi.fn();
  const app = {
    db: overrides.db ?? { __marker: "fake-db" },
    usageLogQueue:
      "usageLogQueue" in overrides ? overrides.usageLogQueue : undefined,
    gwMetrics: {
      pricingMissTotal: { inc: pricingMissInc },
      usagePersistLostTotal: { inc: persistLostInc },
      upstreamDurationSeconds: { observe: upstreamDurationObserve },
    },
  };
  return app as unknown as FastifyInstance;
}

function fakeAccountBillingDb(row: {
  type: string;
  rateMultiplier: string;
}): unknown {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
  };
}

// Cache a pricing map that contains a single known model so we can exercise
// hit + miss paths deterministically. The real `loadPricing()` reads from
// disk; we reset the module-level cache between tests to prevent leakage.
beforeEach(() => {
  resetPricingCacheForTests();
});

// ── extractUsageFromAnthropicResponse ────────────────────────────────────────

describe("extractUsageFromAnthropicResponse", () => {
  it("1. full usage — returns all four token counts + model", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "claude-3-5-haiku-20241022",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    });
    expect(out).toEqual({
      model: "claude-3-5-haiku-20241022",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("2. missing optional cache tokens — defaults to 0", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "claude-3-5-haiku-20241022",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(out.cacheCreationTokens).toBe(0);
    expect(out.cacheReadTokens).toBe(0);
  });

  it("3. non-object input — returns all zeros + empty model", () => {
    expect(extractUsageFromAnthropicResponse(null)).toEqual({
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cachedInputTokens: 0,
    });
    expect(extractUsageFromAnthropicResponse("string")).toEqual({
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("4. negative / non-numeric token counts are coerced to 0", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "m",
      usage: {
        input_tokens: -5,
        output_tokens: NaN,
        cache_creation_input_tokens: "fifty",
        cache_read_input_tokens: 7.9,
      },
    });
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.cacheCreationTokens).toBe(0);
    // 7.9 should floor to 7 (the helper accepts non-integer finite ≥0).
    expect(out.cacheReadTokens).toBe(7);
  });
});

// ── buildUsageLogPayload ─────────────────────────────────────────────────────

describe("buildUsageLogPayload", () => {
  it("5. full happy path — payload matches spec shape, decimals scale 10", async () => {
    const pricing = getPricing();
    const { payload, cost } = await buildUsageLogPayload({
      req: makeReq({ id: "req-happy-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1234,
      pricing,
    });

    expect(cost.miss).toBe(false);
    expect(payload).toMatchObject({
      requestId: "req-happy-1",
      userId: VALID_UUID_USER,
      apiKeyId: VALID_UUID_KEY,
      accountId: VALID_UUID_ACCT,
      orgId: VALID_UUID_ORG,
      teamId: null,
      requestedModel: "claude-3-5-haiku-20241022",
      upstreamModel: "claude-3-5-haiku-20241022",
      platform: "anthropic",
      surface: "messages",
      stream: false,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      rateMultiplier: "1.0000",
      accountRateMultiplier: "1.0000",
      statusCode: 200,
      durationMs: 1234,
      firstTokenMs: null,
      bufferReleasedAtMs: null,
      upstreamRetries: 0,
      failedAccountIds: [],
      userAgent: "vitest/1.0",
      ipAddress: "127.0.0.1",
    });
    // Decimal strings: scale 10 enforced via toFixed(10)
    expect(payload.inputCost).toMatch(/^\d+\.\d{10}$/);
    expect(payload.outputCost).toMatch(/^\d+\.\d{10}$/);
    expect(payload.totalCost).toMatch(/^\d+\.\d{10}$/);
    // 1000 input * $0.0000008 + 500 output * $0.000004 = 0.0008 + 0.002 = 0.0028
    expect(payload.totalCost).toBe("0.0028000000");
  });

  it("6. pricing miss — costs are '0.0000000000', miss=true", async () => {
    const pricing = getPricing();
    const { payload, cost } = await buildUsageLogPayload({
      req: makeReq(),
      requestedModel: "unknown-model-xyz",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "unknown-model-xyz",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 10,
      pricing,
    });
    expect(cost.miss).toBe(true);
    expect(payload.inputCost).toBe("0.0000000000");
    expect(payload.outputCost).toBe("0.0000000000");
    expect(payload.cacheCreationCost).toBe("0.0000000000");
    expect(payload.cacheReadCost).toBe("0.0000000000");
    expect(payload.totalCost).toBe("0.0000000000");
    // Tokens still recorded even on miss — forensic row.
    expect(payload.inputTokens).toBe(999);
    expect(payload.outputTokens).toBe(999);
  });

  it("7. teamId is preserved when apiKey has one", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ teamId: VALID_UUID_TEAM }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
      pricing,
    });
    expect(payload.teamId).toBe(VALID_UUID_TEAM);
  });

  it("8. missing user-agent / ip — both null", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ headers: {}, ip: "" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
      pricing,
    });
    expect(payload.userAgent).toBeNull();
    // Empty-string ip → null: Postgres `inet` rejects empty strings, so the
    // helper normalises `""` to `null` before enqueue. (Non-empty strings
    // are preserved verbatim; Fastify always sets a sensible value in prod.)
    expect(payload.ipAddress).toBeNull();
  });

  it("9a. stream=true + firstTokenMs/bufferReleasedAtMs propagate", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-stream-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 2500,
      pricing,
      stream: true,
      firstTokenMs: 150,
      bufferReleasedAtMs: 400,
    });
    expect(payload.stream).toBe(true);
    expect(payload.firstTokenMs).toBe(150);
    expect(payload.bufferReleasedAtMs).toBe(400);
  });

  it("9b. stream=true + omitted ms fields default to null", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-stream-2" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 10,
      pricing,
      stream: true,
      // firstTokenMs + bufferReleasedAtMs omitted — upstream emitted zero
      // bytes before close, so we never measured them.
    });
    expect(payload.stream).toBe(true);
    expect(payload.firstTokenMs).toBeNull();
    expect(payload.bufferReleasedAtMs).toBeNull();
  });

  it("9c. stream=false explicit — ms fields ignored even if provided", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-stream-false-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 5,
      pricing,
      stream: false,
      // Caller accidentally passes ms fields on a non-streaming payload —
      // contract requires these to be zeroed so the column meaning stays
      // tight ("null iff non-streaming OR streaming-but-not-measured").
      firstTokenMs: 100,
      bufferReleasedAtMs: 200,
    });
    expect(payload.stream).toBe(false);
    expect(payload.firstTokenMs).toBeNull();
    expect(payload.bufferReleasedAtMs).toBeNull();
  });

  it("9. platform=openai + surface=chat-completions propagate", async () => {
    const pricing = getPricing();
    const { payload } = await buildUsageLogPayload({
      req: makeReq(),
      requestedModel: "gpt-4",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      platform: "openai",
      surface: "chat-completions",
      statusCode: 200,
      durationMs: 99,
      pricing,
    });
    expect(payload.platform).toBe("openai");
    expect(payload.surface).toBe("chat-completions");
    // requestedModel = gpt-4, upstreamModel = claude-3-5-haiku-20241022
    expect(payload.requestedModel).toBe("gpt-4");
    expect(payload.upstreamModel).toBe("claude-3-5-haiku-20241022");
  });
});

// ── emitUsageLog ─────────────────────────────────────────────────────────────

describe("emitUsageLog", () => {
  it("10. happy path — enqueues with fallback wired", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const app = makeApp({
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-emit-happy" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 50,
    });

    expect(addFn).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = addFn.mock.calls[0]!;
    expect(jobName).toBe("usage-log");
    expect(jobOpts).toMatchObject({ jobId: "req-emit-happy" });
    const payload = jobData as UsageLogJobPayload;
    expect(payload.requestId).toBe("req-emit-happy");
    expect(payload.platform).toBe("anthropic");
    expect(payload.surface).toBe("messages");
    // gw_upstream_duration_seconds (issue #190): durationMs=50 → observe(0.05s).
    expect(app.gwMetrics.upstreamDurationSeconds.observe).toHaveBeenCalledWith(
      0.05,
    );
    // pricingMissTotal.inc should NOT have been called for a known model.
    expect(app.gwMetrics.pricingMissTotal.inc).not.toHaveBeenCalled();
  });

  it("10a. emit path defaults group/account multipliers from request context and DB", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const groupId = "66666666-6666-4666-8666-666666666666";
    const app = makeApp({
      db: fakeAccountBillingDb({
        type: "api_key",
        rateMultiplier: "2.0000",
      }),
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({
      id: "req-emit-mult-defaults",
      gwGroupContext: {
        groupId,
        rateMultiplier: 1.5,
        isLegacy: false,
        isByok: false,
      },
    });

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 50,
    });

    const payload = addFn.mock.calls[0]![1] as UsageLogJobPayload;
    expect(payload.totalCost).toBe("0.0028000000");
    expect(payload.actualCostUsd).toBe("0.0084000000");
    expect(payload.groupId).toBe(groupId);
    expect(payload.rateMultiplier).toBe("1.5000");
    expect(payload.accountRateMultiplier).toBe("2.0000");
  });

  it("10b. emit path uses scheduled account billing metadata without DB fallback", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const select = vi.fn(() => {
      throw new Error("account metadata fallback should not run");
    });
    const app = makeApp({
      db: { select },
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-emit-scheduled-account-metadata" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 50,
      accountRateMultiplier: "2.0000",
      accountType: "apikey",
    });

    expect(select).not.toHaveBeenCalled();
    const payload = addFn.mock.calls[0]![1] as UsageLogJobPayload;
    expect(payload.actualCostUsd).toBe("0.0056000000");
    expect(payload.accountRateMultiplier).toBe("2.0000");
  });

  it("11. test mode — no usageLogQueue, no enqueue + debug log", async () => {
    const app = makeApp({ usageLogQueue: undefined });
    const req = makeReq();

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
    });

    expect(req.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-test-1" }),
      expect.stringContaining("usage log queue absent"),
    );
  });

  it("12. pricing miss — bumps counter + warn + still enqueues zero-cost row", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const app = makeApp({
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-miss-1" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "unknown-xyz",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "unknown-xyz",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
    });

    expect(app.gwMetrics.pricingMissTotal.inc).toHaveBeenCalledWith({
      model: "unknown-xyz",
    });
    expect(req.log.warn).toHaveBeenCalled();
    expect(addFn).toHaveBeenCalledTimes(1);
    const payload = addFn.mock.calls[0]![1] as UsageLogJobPayload;
    expect(payload.totalCost).toBe("0.0000000000");
  });

  it("13. BullMQ enqueue error AND fallback fails — warn but do not throw", async () => {
    // The real `enqueueUsageLog` will try `queue.add` → fail → invoke
    // `writeUsageLogBatch` on `app.db` → fail (no real DB) → log
    // gw_usage_persist_lost + re-throw. emitUsageLog must swallow that.
    const addFn = vi.fn().mockRejectedValue(new Error("redis down"));
    const app = makeApp({
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-fail-1" });

    await expect(
      emitUsageLog({
        app,
        req,
        requestedModel: "claude-3-5-haiku-20241022",
        accountId: VALID_UUID_ACCT,
        upstreamResponse: {
          model: "claude-3-5-haiku-20241022",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        platform: "anthropic",
        surface: "messages",
        statusCode: 200,
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(addFn).toHaveBeenCalledTimes(1);
    // Route handler's warn fires after enqueueUsageLog's own error log.
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-fail-1" }),
      expect.stringContaining("usage log persist failed"),
    );
  });

  it("13a. streaming enqueue — stream=true + ms fields propagate into payload", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const app = makeApp({
      usageLogQueue: {
        add: addFn,
      } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-emit-stream-1" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 50, output_tokens: 25 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1500,
      stream: true,
      firstTokenMs: 100,
      bufferReleasedAtMs: 350,
    });

    expect(addFn).toHaveBeenCalledTimes(1);
    const payload = addFn.mock.calls[0]![1] as UsageLogJobPayload;
    expect(payload.stream).toBe(true);
    expect(payload.firstTokenMs).toBe(100);
    expect(payload.bufferReleasedAtMs).toBe(350);
    expect(payload.statusCode).toBe(200);
    expect(payload.durationMs).toBe(1500);
  });

  it("14. buildUsageLogPayload/metering throws — warn but do not throw (never-throws contract)", async () => {
    // Force a throw on the payload-building side of emitUsageLog by handing
    // it an `app` whose `gwMetrics` is undefined. When the upstream body
    // triggers a pricing miss, emitUsageLog will dereference
    // `app.gwMetrics.pricingMissTotal.inc` and hit a TypeError — exactly
    // the kind of unexpected failure the widened try/catch must swallow.
    const badApp = {
      db: { __marker: "fake-db" },
      usageLogQueue: undefined,
      gwMetrics: undefined, // ← missing; .pricingMissTotal access will throw
    } as unknown as FastifyInstance;
    const req = makeReq({ id: "req-build-throw-1" });

    await expect(
      emitUsageLog({
        app: badApp,
        req,
        requestedModel: "unknown-xyz",
        accountId: VALID_UUID_ACCT,
        upstreamResponse: {
          // Pricing miss → hits the gwMetrics access that will throw.
          model: "unknown-xyz",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        platform: "anthropic",
        surface: "messages",
        statusCode: 200,
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-build-throw-1" }),
      expect.stringContaining("usage log emit failed; user request unaffected"),
    );
  });
});

// ── Plan 5A: two-stage cost emission ─────────────────────────────────────────

describe("buildUsageLogPayload — Plan 5A two-stage cost", () => {
  const haikuUpstream = {
    model: "claude-3-5-haiku-20241022",
    usage: { input_tokens: 1000, output_tokens: 500 },
  };

  // Minimal in-memory PricingLookup that always returns a known row.  Lets
  // the test exercise the new `computeCost` path without spinning up a DB
  // (an integration test in 0010.test.ts covers the real lookup).
  function fakeLookup(row: {
    inputPerMillionMicros: bigint;
    outputPerMillionMicros: bigint;
    cached5mPerMillionMicros: bigint | null;
    cached1hPerMillionMicros: bigint | null;
    cachedInputPerMillionMicros: bigint | null;
    cacheReadPerMillionMicros?: bigint | null;
  }) {
    return {
      lookup: vi.fn().mockResolvedValue({
        cacheReadPerMillionMicros: null,
        ...row,
      }),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    };
  }
  function fakeMissLookup() {
    return {
      lookup: vi.fn().mockResolvedValue(null),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    };
  }

  it("OAuth account: cost=0, actualCost=0, no DB lookup attempted", async () => {
    const lookup = fakeLookup({
      inputPerMillionMicros: 999_999_999n,
      outputPerMillionMicros: 999_999_999n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cachedInputPerMillionMicros: null,
    });
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-oauth-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "oauth",
    });
    expect(payload.totalCost).toBe("0.0000000000");
    expect(payload.actualCostUsd).toBe("0.0000000000");
    expect(payload.inputCost).toBe("0.0000000000");
    expect(payload.outputCost).toBe("0.0000000000");
    // OAuth path skips the lookup entirely — subscription rows shouldn't
    // even read pricing.
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it("apikey + pricingLookup hit: uses computeCost path (bigint micros)", async () => {
    const lookup = fakeLookup({
      // $5/M input, $25/M output — distinct from anything in litellm.json so
      // we can prove the new path won.
      inputPerMillionMicros: 5_000_000n,
      outputPerMillionMicros: 25_000_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cachedInputPerMillionMicros: null,
    });
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-lookup-hit-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "apikey",
    });
    // 1000 × $5/M = $0.005, 500 × $25/M = $0.0125, total $0.0175
    expect(payload.inputCost).toBe("0.0050000000");
    expect(payload.outputCost).toBe("0.0125000000");
    expect(payload.totalCost).toBe("0.0175000000");
    expect(payload.actualCostUsd).toBe("0.0175000000");
    expect(lookup.lookup).toHaveBeenCalledWith(
      "anthropic",
      "claude-3-5-haiku-20241022",
      expect.any(Date),
    );
  });

  it("apikey + pricingLookup miss: falls back to legacy resolveCost", async () => {
    const lookup = fakeMissLookup();
    // litellm.json HAS claude-3-5-haiku-20241022 at input 0.0000008/token =
    // $0.80/M, output 0.000004/token = $4/M. 1000 in / 500 out:
    //   input: 1000 × 0.0000008 = $0.0008
    //   output: 500 × 0.000004 = $0.002
    //   total: $0.0028
    const { payload, cost } = await buildUsageLogPayload({
      req: makeReq({ id: "req-lookup-miss-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "apikey",
    });
    expect(cost.miss).toBe(false);
    expect(payload.inputCost).toBe("0.0008000000");
    expect(payload.outputCost).toBe("0.0020000000");
    expect(payload.totalCost).toBe("0.0028000000");
    expect(lookup.lookup).toHaveBeenCalledTimes(1);
  });

  it("rateMultiplier=1.5 multiplies actualCost; totalCost stays raw", async () => {
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-mult-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      rateMultiplier: "1.5000",
    });
    // Legacy path: total = $0.0028; actualCost = $0.0028 × 1.5 = $0.0042
    expect(payload.totalCost).toBe("0.0028000000");
    expect(payload.actualCostUsd).toBe("0.0042000000");
    expect(payload.rateMultiplier).toBe("1.5000");
  });

  it("rateMultiplier × accountRateMultiplier compose into actualCost", async () => {
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-mult-compose-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      rateMultiplier: "1.5000",
      accountRateMultiplier: "2.0000",
    });
    // total = $0.0028; actual = $0.0028 × 1.5 × 2.0 = $0.0084
    expect(payload.totalCost).toBe("0.0028000000");
    expect(payload.actualCostUsd).toBe("0.0084000000");
    expect(payload.rateMultiplier).toBe("1.5000");
    expect(payload.accountRateMultiplier).toBe("2.0000");
  });

  it("groupId is threaded through to the payload (null when omitted)", async () => {
    const groupId = "66666666-6666-4666-8666-666666666666";
    const { payload: withGroup } = await buildUsageLogPayload({
      req: makeReq({ id: "req-group-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      groupId,
    });
    expect(withGroup.groupId).toBe(groupId);

    const { payload: noGroup } = await buildUsageLogPayload({
      req: makeReq({ id: "req-no-group-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: haikuUpstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
    });
    expect(noGroup.groupId).toBeNull();
  });

  it("OpenAI cached_input: pricingLookup populates cachedInputCost separately", async () => {
    const lookup = fakeLookup({
      inputPerMillionMicros: 2_500_000n, // $2.5/M
      outputPerMillionMicros: 10_000_000n, // $10/M
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cachedInputPerMillionMicros: 1_250_000n, // $1.25/M
    });
    const openaiUpstream = {
      // Anthropic-shaped extractor doesn't read OpenAI cached_input from the
      // wire (Part 9 wires that). For this test we craft an upstream where
      // cached_input is preset via the extractor returning 0; we simulate
      // OpenAI cached_input by extending the extracted usage manually.
      // Plan 5A defaults cached_input to 0 here so the cost is also 0.
      model: "gpt-4o",
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-openai-1" }),
      requestedModel: "gpt-4o",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: openaiUpstream,
      platform: "openai",
      surface: "chat-completions",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "apikey",
    });
    // cachedInputTokens=0 ⇒ cachedInputCost=0; input 1000 × $2.5/M = $0.0025;
    // output 100 × $10/M = $0.001; total $0.0035.
    expect(payload.cachedInputTokens).toBe(0);
    expect(payload.cachedInputCost).toBe("0.0000000000");
    expect(payload.inputCost).toBe("0.0025000000");
    expect(payload.outputCost).toBe("0.0010000000");
    expect(payload.totalCost).toBe("0.0035000000");
  });

  it("OpenAI cached_input > 0: cached portion charged at discount rate, separate column", async () => {
    // The extractor reads `usage.prompt_tokens_details.cached_tokens` so we
    // can drive the OpenAI cached-input path without a Part 9 dedicated
    // OpenAI extractor — keep the test's only inputs the upstream wire
    // shape + lookup row.
    const lookup = fakeLookup({
      inputPerMillionMicros: 2_500_000n, // $2.5/M
      outputPerMillionMicros: 10_000_000n, // $10/M
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cachedInputPerMillionMicros: 1_250_000n, // $1.25/M
    });
    const openaiUpstream = {
      model: "gpt-4o",
      usage: {
        // The extractor reads `input_tokens` (the Anthropic field name).
        // OpenAI emits `prompt_tokens` natively; Part 9 will route OpenAI
        // responses to a parallel extractor.  Using the Anthropic field
        // name here exercises the cost path without depending on Part 9.
        input_tokens: 1000,
        output_tokens: 100,
        prompt_tokens_details: { cached_tokens: 200 },
      },
    };
    const { payload } = await buildUsageLogPayload({
      req: makeReq({ id: "req-openai-cached-1" }),
      requestedModel: "gpt-4o",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: openaiUpstream,
      platform: "openai",
      surface: "chat-completions",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "apikey",
    });
    // OpenAI semantics: prompt_tokens = 1000 includes the 200 cached portion.
    // billable = 1000 - 200 = 800 → input cost 800 × $2.5/M = $0.002
    // cached_input cost 200 × $1.25/M = $0.00025
    // output cost 100 × $10/M = $0.001
    // total = $0.002 + $0.00025 + $0.001 = $0.00325
    expect(payload.cachedInputTokens).toBe(200);
    expect(payload.cachedInputCost).toBe("0.0002500000");
    expect(payload.inputCost).toBe("0.0020000000");
    expect(payload.outputCost).toBe("0.0010000000");
    expect(payload.totalCost).toBe("0.0032500000");
    // pricingLookup.lookup was called exactly once for this request (no
    // double-lookup between cost path and cached-input path).
    expect(lookup.lookup).toHaveBeenCalledTimes(1);
  });

  it("Anthropic + cache_creation/read tokens: matches legacy resolveCost (no underbill regression)", async () => {
    // PR #33 review #1: Anthropic's input_tokens is uncached-only;
    // cache_creation_input_tokens + cache_read_input_tokens are independent
    // counts that don't overlap.  computeCost's contract treats inputTokens
    // as "total prompt size", so the caller must re-aggregate before
    // calling — otherwise the subtraction in computeCost would underbill.
    //
    // This test feeds the same usage through BOTH the new (lookup hit)
    // path and the legacy resolveCost path and asserts the resulting
    // dollar amounts match — protecting against future drift.
    const upstream = {
      model: "claude-3-5-haiku-20241022",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    };
    // Pricing row equal to litellm.json claude-3-5-haiku-20241022:
    //   input    $0.80/M = 800_000 micros
    //   output   $4/M    = 4_000_000 micros
    //   cached_5m $1/M   = 1_000_000 micros (litellm's
    //                       cache_creation_input_token_cost; we use it as
    //                       the 5m bucket since legacy maps everything
    //                       there)
    //   cache_read uses dedicated cacheReadPerMillionMicros (post-0011).
    //   Match litellm.json's cache_read_input_token_cost ($0.08/M for
    //   haiku) so this regression test asserts FULL parity between new
    //   and legacy paths.
    const lookup = fakeLookup({
      inputPerMillionMicros: 800_000n,
      outputPerMillionMicros: 4_000_000n,
      cached5mPerMillionMicros: 1_000_000n,
      cached1hPerMillionMicros: null,
      cacheReadPerMillionMicros: 80_000n, // $0.08/M — matches legacy
      cachedInputPerMillionMicros: null,
    });

    const { payload: newPath } = await buildUsageLogPayload({
      req: makeReq({ id: "req-anthropic-cache-new-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: upstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      pricingLookup: lookup,
      accountType: "apikey",
    });
    const { payload: legacyPath } = await buildUsageLogPayload({
      req: makeReq({ id: "req-anthropic-cache-legacy-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: upstream,
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 100,
      pricing: getPricing(),
      // No pricingLookup → legacy path.
      accountType: "apikey",
    });

    // FULL PARITY (post-migration-0011):
    //   - input cost: re-aggregation fix from PR #33 review (Anthropic's
    //     input_tokens is uncached-only; caller adds cache fields back
    //     before computeCost subtracts them so each token bills once)
    //   - output / cacheCreation: rate match between paths
    //   - cacheRead: now bills at the dedicated cacheReadPerMillionMicros
    //     instead of fallback-to-input — eliminating the ~10× overbill
    //     that was a KNOWN DIVERGENCE in PR #33.
    expect(newPath.inputCost).toBe(legacyPath.inputCost);
    expect(newPath.outputCost).toBe(legacyPath.outputCost);
    expect(newPath.cacheCreationCost).toBe(legacyPath.cacheCreationCost);
    expect(newPath.cacheReadCost).toBe(legacyPath.cacheReadCost);
    expect(newPath.totalCost).toBe(legacyPath.totalCost);
    // Concrete dollar check (anchors the assertions above).
    //   input          1000 × $0.80/M = $0.0008
    //   output          500 × $4/M    = $0.002
    //   cache_creation  100 × $1/M    = $0.0001
    //   cache_read      200 × $0.08/M = $0.000016
    //   total = $0.002916
    expect(newPath.inputCost).toBe("0.0008000000");
    expect(newPath.outputCost).toBe("0.0020000000");
    expect(newPath.cacheCreationCost).toBe("0.0001000000");
    expect(newPath.cacheReadCost).toBe("0.0000160000");
    expect(newPath.totalCost).toBe("0.0029160000");
  });
});
