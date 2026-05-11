import { defineConfig, devices } from "@playwright/test";
import {
  E2E_API_KEY_HASH_PEPPER,
  E2E_CREDENTIAL_ENCRYPTION_KEY,
  E2E_FAKE_ANTHROPIC_PORT,
  E2E_FAKE_ANTHROPIC_URL,
  E2E_GATEWAY_BASE_URL,
  E2E_GATEWAY_PORT,
} from "./fixtures/gateway-env";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3001);
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? E2E_GATEWAY_PORT);
const FAKE_ANTHROPIC_PORT = Number(
  process.env.FAKE_ANTHROPIC_PORT ?? E2E_FAKE_ANTHROPIC_PORT,
);
const isCI = !!process.env.CI;

// Must match what the API is configured with via ENABLE_TEST_SEED + TEST_SEED_TOKEN.
// Fixtures read this from process.env too.
const SEED_TOKEN =
  process.env.TEST_SEED_TOKEN ?? "e2e-test-token-0000000000000000000000";

// parseServerEnv() runs at api + web startup and rejects the process if any
// required var is missing. Playwright's webServer.env *replaces* process.env
// rather than merging it, so we have to forward the whole server schema.
//
// Defaults below are E2E-safe: OAuth creds are never actually called (we
// mock sessions via cookie injection), AUTH_SECRET just needs ≥32 bytes, and
// BOOTSTRAP_* values only feed the "first sign-in" flow which specs don't
// currently exercise. Only DATABASE_URL deserves a real value — default
// matches the dev compose creds so zero-config local runs just work.
const appEnvDefaults: Record<string, string> = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://caliber:caliber_dev@localhost:5432/caliber",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "0".repeat(48),
  NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? `http://localhost:${WEB_PORT}`,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "e2e",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "e2e",
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "e2e",
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "e2e",
  BOOTSTRAP_SUPER_ADMIN_EMAIL:
    process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL ?? "admin@e2e.test",
  BOOTSTRAP_DEFAULT_ORG_SLUG: process.env.BOOTSTRAP_DEFAULT_ORG_SLUG ?? "demo",
  BOOTSTRAP_DEFAULT_ORG_NAME: process.env.BOOTSTRAP_DEFAULT_ORG_NAME ?? "Demo",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
};

// Gateway env additions. These override any parent-process values so the
// locally-spawned gateway always points at the Playwright-managed fake
// upstream rather than whatever real URL the dev shell may have exported.
const gatewayEnv: Record<string, string> = {
  ENABLE_GATEWAY: "true",
  GATEWAY_PORT: String(GATEWAY_PORT),
  GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL ?? E2E_GATEWAY_BASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  CREDENTIAL_ENCRYPTION_KEY:
    process.env.CREDENTIAL_ENCRYPTION_KEY ?? E2E_CREDENTIAL_ENCRYPTION_KEY,
  API_KEY_HASH_PEPPER:
    process.env.API_KEY_HASH_PEPPER ?? E2E_API_KEY_HASH_PEPPER,
  UPSTREAM_ANTHROPIC_BASE_URL:
    process.env.UPSTREAM_ANTHROPIC_BASE_URL ??
    `http://localhost:${FAKE_ANTHROPIC_PORT}`,
  FAKE_ANTHROPIC_PORT: String(FAKE_ANTHROPIC_PORT),
};

// Sanitised passthrough of the parent environment (PATH, HOME, pnpm cache,
// etc. are needed for the child process to even spawn correctly). Filter
// undefined values because Playwright rejects those.
const inheritedEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

export default defineConfig({
  testDir: "./specs",
  outputDir: "./.playwright",
  // Specs share a single database, so run serially to avoid seed collisions.
  // Parallelising would require per-worker database isolation — deferred.
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI
    ? [
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["github"],
      ]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // In CI the workflow starts api+web+gateway+fake-upstream itself before
  // invoking playwright (see .github/workflows/ci.yml e2e job). Locally,
  // auto-boot the full dev stack for convenience.
  //
  // Local prereq: Redis reachable on :6379 (e.g. `docker compose up redis`).
  // The gateway webServer below will fail fast if Redis is missing — we do
  // NOT try to start Redis from Playwright because container lifecycle in a
  // dev loop is too fragile.
  webServer: isCI
    ? undefined
    : [
        {
          command: `pnpm --filter @caliber/api dev`,
          url: `http://localhost:${API_PORT}/health`,
          timeout: 60_000,
          reuseExistingServer: true,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            ...appEnvDefaults,
            NODE_ENV: "test",
            ENABLE_TEST_SEED: "true",
            TEST_SEED_TOKEN: SEED_TOKEN,
            PORT: String(API_PORT),
          },
        },
        {
          command: `pnpm --filter @caliber/web dev`,
          url: `http://localhost:${WEB_PORT}/sign-in`,
          timeout: 120_000,
          reuseExistingServer: true,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            ...appEnvDefaults,
            NODE_ENV: "development",
            API_INTERNAL_URL: `http://localhost:${API_PORT}`,
            PORT: String(WEB_PORT),
          },
        },
        {
          // Fake Anthropic upstream. Self-contained .mjs so `node` runs it
          // directly — no tsx / pnpm exec wrapper chain (the wrapper chain
          // was producing a live-but-unreachable child under nohup on CI,
          // see run-fake-anthropic.mjs module header).
          //
          // Probes GET / and receives 200 JSON so wait-on / the webServer
          // readiness check pass cleanly.
          command: `node apps/web/e2e/fixtures/run-fake-anthropic.mjs`,
          cwd: "../..",
          url: `http://localhost:${FAKE_ANTHROPIC_PORT}/`,
          timeout: 30_000,
          reuseExistingServer: true,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            FAKE_ANTHROPIC_PORT: String(FAKE_ANTHROPIC_PORT),
          },
        },
        {
          command: `pnpm --filter @caliber/gateway dev`,
          url: `http://localhost:${GATEWAY_PORT}/health`,
          timeout: 60_000,
          reuseExistingServer: true,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            ...appEnvDefaults,
            ...gatewayEnv,
            NODE_ENV: "test",
          },
        },
      ],
});
