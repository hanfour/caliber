import { defineConfig } from "vitest/config";

/**
 * Repo-wide coverage gate.
 *
 * Scope (important): this gate only measures code that is *designed* to be
 * unit-tested — i.e. pure-ish logic packages. Everything else is covered by
 * a more appropriate layer and is intentionally excluded:
 *
 *   - `apps/api/src/**` (tRPC routers, services, REST handlers) is exercised
 *     by the integration suite against a real Postgres via testcontainers
 *     (`pnpm --filter @caliber/api test:integration`). Measuring unit coverage
 *     here would reward trivial mocks over real behaviour.
 *   - `apps/web/src/**` (React pages, server components) is covered by the
 *     Playwright E2E flows in `apps/web/e2e/specs/`.
 *   - `packages/db/src/schema/**` is declarative Drizzle tables with no
 *     branches to cover; migrate/seed run as part of integration setup.
 *
 * Per-package gates (e.g. @caliber/auth ≥ 95%) live in the package's own
 * `vitest.config.ts` and still run via `pnpm --filter <pkg> test`.
 *
 * Projects run sequentially because @caliber/auth spins up testcontainers and
 * parallel Docker pulls race.
 */
export default defineConfig({
  test: {
    projects: ["./packages/config", "./packages/auth"],
    fileParallelism: false,
    maxWorkers: 1,
    coverage: {
      // Turn coverage on without requiring `--coverage` on the CLI, so
      // `pnpm test:coverage` is a single, obvious entry point.
      enabled: true,
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      reportsDirectory: "./coverage",
      all: true,
      include: [
        "packages/config/src/**/*.{ts,tsx}",
        "packages/auth/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.d.ts",
        "**/tests/**",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        // Barrel files — re-exports only, no logic.
        "**/index.ts",
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
