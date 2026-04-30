import type { TRPCRouterCaller } from "@trpc/server";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import type { ServerEnv } from "@aide/config";
import { resolvePermissions } from "@aide/auth";
import { appRouter, type AppRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/procedures.js";
import type { TrpcLogger } from "../../src/trpc/context.js";

// Test logger: drop-on-the-floor so router-internal warn/info/error don't
// pollute vitest output. Tests that need to assert on log calls can construct
// a spy and pass it explicitly via the optional `logger` arg.
export const noopTestLogger: TrpcLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
};

// Explicit annotations needed: tRPC v11's inferred caller types reference
// an internal `unstable-core-do-not-import.d-*.mts` bundle, which TS flags
// as non-portable (TS2742) when `declaration: true` is set in the base tsconfig.
// Anchoring to the publicly-exported `TRPCRouterCaller` avoids that.
type AppCaller = TRPCRouterCaller<
  AppRouter["_def"]["_config"]["$types"],
  AppRouter["_def"]["record"]
>;
type AppCallerInvocation = ReturnType<AppCaller>;

const createCaller: AppCaller = createCallerFactory(appRouter);

// Default test env carries everything the routers need so tests don't have to
// hand-roll one. Gateway is enabled (so accounts/apiKeys/usage routers don't
// short-circuit to NOT_FOUND) and CREDENTIAL_ENCRYPTION_KEY is a valid 32-byte
// (64-hex-char) key. Tests that need to assert the gateway-disabled NOT_FOUND
// path can pass `env: { ...defaultTestEnv, ENABLE_GATEWAY: false }`.
export const defaultTestEnv: ServerEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  AUTH_SECRET: "test-auth-secret-must-be-at-least-32-chars-long",
  NEXTAUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-google-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  GITHUB_CLIENT_ID: "test-github-id",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@test.test",
  BOOTSTRAP_DEFAULT_ORG_SLUG: "default",
  BOOTSTRAP_DEFAULT_ORG_NAME: "Default",
  ENABLE_SWAGGER: false,
  LOG_LEVEL: "info",
  API_INTERNAL_URL: undefined,
  ENABLE_TEST_SEED: false,
  TEST_SEED_TOKEN: undefined,

  ENABLE_GATEWAY: true,
  GATEWAY_PORT: 3002,
  GATEWAY_BASE_URL: "http://localhost:3002",
  REDIS_URL: "redis://localhost:6379",
  CREDENTIAL_ENCRYPTION_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  API_KEY_HASH_PEPPER:
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  UPSTREAM_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  UPSTREAM_OPENAI_BASE_URL: "https://api.openai.com",
  GATEWAY_MAX_ACCOUNT_SWITCHES: 10,
  GATEWAY_MAX_BODY_BYTES: 10485760,
  GATEWAY_BUFFER_WINDOW_MS: 500,
  GATEWAY_BUFFER_WINDOW_BYTES: 2048,
  GATEWAY_REDIS_FAILURE_MODE: "strict",
  GATEWAY_IDEMPOTENCY_TTL_SEC: 300,
  GATEWAY_TRUSTED_PROXIES: "",
  GATEWAY_OAUTH_REFRESH_LEAD_MIN: 10,
  GATEWAY_OAUTH_MAX_FAIL: 3,
  GATEWAY_QUEUE_SATURATE_THRESHOLD: 5000,
  GATEWAY_LOCAL_BASE_URL: "http://localhost:3002",
  ENABLE_EVALUATOR: true,
  ENABLE_FACET_EXTRACTION: false,
};

// ioredis-mock honors keyPrefix the same way the real client does, so tests
// asserting against the underlying keyspace can use the prefixed form
// (`aide:gw:key-reveal:<token>`) and verify both the gateway namespace
// contract and the api-side stash semantics in one shot.
export function makeTestRedis(): Redis {
  return new RedisMock({ keyPrefix: "aide:gw:" }) as unknown as Redis;
}

export const defaultTestRedis: Redis = makeTestRedis();

export async function callerFor(
  db: Database,
  userId: string,
  email = "x@x.test",
  env: ServerEnv = defaultTestEnv,
  redis: Redis = defaultTestRedis,
): Promise<AppCallerInvocation> {
  const perm = await resolvePermissions(db, userId);
  return createCaller({
    db,
    user: { id: userId, email },
    perm,
    reqId: "test",
    env,
    redis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

export async function anonCaller(
  db: Database,
  env: ServerEnv = defaultTestEnv,
  redis: Redis = defaultTestRedis,
): Promise<AppCallerInvocation> {
  return createCaller({
    db,
    user: null,
    perm: null,
    reqId: "test",
    env,
    redis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}
