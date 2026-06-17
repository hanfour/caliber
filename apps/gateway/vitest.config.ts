import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "scripts/**/__tests__/**/*.test.ts"],
    exclude: [
      "tests/**/*.integration.test.ts",
      // Load-harness scenarios (#206) need testcontainers + the long load-lane
      // timeout; they run only via `pnpm test:load` (vitest.load.config.ts).
      // The plain-suffixed `tests/load/*.test.ts` self-tests stay in this lane.
      "tests/**/*.load.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
