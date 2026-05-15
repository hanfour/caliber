import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Nuke stale testcontainers from previous interrupted runs before the
    // suite starts. See the file for the why + opt-out env var.
    globalSetup: ['./tests/setup/cleanup-testcontainers.ts']
  }
})
