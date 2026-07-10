import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // schema.test.ts starts PostgreSQL; keep it from competing with other
    // files for the Testcontainers reaper/runtime on constrained CI runners.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
