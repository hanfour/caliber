import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Four suites start PostgreSQL containers. Serial files avoid Docker
    // startup timeouts when Turbo runs package tests concurrently.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Spec §8.1 / §14 DoD: packages/auth ≥ 95%.
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 }
    }
  }
})
