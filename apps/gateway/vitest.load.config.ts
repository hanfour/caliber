import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/load/**/*.load.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Serial: prom-client uses a process-global registry; parallel app
    // instances would share/clear it and race the C0 metric deltas.
    // (Vitest 4 removed `poolOptions.threads`; `fileParallelism: false`
    // plus single min/max workers is the supported single-thread form.)
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
