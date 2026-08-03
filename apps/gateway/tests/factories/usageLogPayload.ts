import type { UsageLogJobPayload } from "../../src/workers/usageLogQueue.js";

const VALID_UUID_USER = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_KEY = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_ACCT = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_ORG = "44444444-4444-4444-8444-444444444444";

/**
 * Shared builder for `UsageLogJobPayload` test fixtures.  Centralises the
 * full schema shape so adding a new column to `usage_logs` (and its zod
 * payload mirror) means updating ONE fixture instead of grepping every
 * worker test.  Callers pass an `overrides` object to set specific fields.
 */
export function makeUsageLogJobPayload(
  overrides: Partial<UsageLogJobPayload> = {},
): UsageLogJobPayload {
  return {
    requestId: "req_test_1",
    userId: VALID_UUID_USER,
    apiKeyId: VALID_UUID_KEY,
    accountId: VALID_UUID_ACCT,
    orgId: VALID_UUID_ORG,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cachedInputTokens: 0,
    inputCost: "0.0030000000",
    outputCost: "0.0090000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    cachedInputCost: "0",
    totalCost: "0.0120000000",
    actualCostUsd: "0.012000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    groupId: null,
    statusCode: 200,
    durationMs: 1234,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
    replayOfRequestId: null,
    ...overrides,
  };
}
