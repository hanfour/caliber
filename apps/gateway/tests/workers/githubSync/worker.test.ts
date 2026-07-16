import { describe, it, expect } from "vitest";
import { computeRateLimitDelayMs } from "../../../src/workers/githubSync/worker.js";

const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms

describe("computeRateLimitDelayMs", () => {
  it("uses resetAtMs - nowMs when resetAtMs is finite and in the future", () => {
    const resetAtMs = NOW + 90_000; // 90s out — within [30s, 3600s] bounds
    expect(computeRateLimitDelayMs(resetAtMs, NOW)).toBe(90_000);
  });

  it("clamps to the 30s floor when resetAtMs is very close", () => {
    const resetAtMs = NOW + 5_000; // 5s out — below the 30s floor
    expect(computeRateLimitDelayMs(resetAtMs, NOW)).toBe(30_000);
  });

  it("clamps to the 1h ceiling when resetAtMs is far out", () => {
    const resetAtMs = NOW + 6 * 60 * 60 * 1000; // 6h out — above the 1h ceiling
    expect(computeRateLimitDelayMs(resetAtMs, NOW)).toBe(3_600_000);
  });

  it("defaults to 5 minutes when resetAtMs is null", () => {
    expect(computeRateLimitDelayMs(null, NOW)).toBe(300_000);
  });

  it("defaults to 5 minutes when resetAtMs is undefined", () => {
    expect(computeRateLimitDelayMs(undefined, NOW)).toBe(300_000);
  });

  it("defaults to 5 minutes when resetAtMs is not finite (NaN/Infinity)", () => {
    expect(computeRateLimitDelayMs(NaN, NOW)).toBe(300_000);
    expect(computeRateLimitDelayMs(Infinity, NOW)).toBe(300_000);
  });

  it("defaults to 5 minutes when resetAtMs is already in the past", () => {
    expect(computeRateLimitDelayMs(NOW - 1000, NOW)).toBe(300_000);
  });

  it("honors custom bounds (test seam for a lower floor)", () => {
    const resetAtMs = NOW + 2_000; // 2s out
    expect(
      computeRateLimitDelayMs(resetAtMs, NOW, { minMs: 1_000 }),
    ).toBe(2_000);
    expect(
      computeRateLimitDelayMs(resetAtMs, NOW, { minMs: 5_000 }),
    ).toBe(5_000);
  });
});
