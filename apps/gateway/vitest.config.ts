import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "scripts/**/__tests__/**/*.test.ts"],
    exclude: [
      "tests/**/*.integration.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
