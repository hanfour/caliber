import { describe, it, expect } from "vitest";
import {
  samplePullsForQuality,
  QUALITY_SAMPLE_SIZE,
  type QualityPullCandidate,
} from "../../src/delivery/qualitySampler";

const pull = (over: Partial<QualityPullCandidate> = {}): QualityPullCandidate => ({
  repoFullName: "org/repo",
  number: 1,
  title: "a pr",
  additions: 10,
  deletions: 0,
  mergedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("samplePullsForQuality", () => {
  it("ranks by log(additions+deletions+1) descending — a much bigger PR outranks a tiny one", () => {
    const small = pull({ number: 1, additions: 2, deletions: 0 });
    const big = pull({ number: 2, additions: 5000, deletions: 2000 });
    const out = samplePullsForQuality([small, big], 2);
    expect(out.map((p) => p.number)).toEqual([2, 1]);
  });

  it("ties on size break by mergedAt descending (newer wins)", () => {
    const older = pull({ number: 1, additions: 10, deletions: 0, mergedAt: new Date("2026-01-01T00:00:00Z") });
    const newer = pull({ number: 2, additions: 10, deletions: 0, mergedAt: new Date("2026-06-01T00:00:00Z") });
    const out = samplePullsForQuality([older, newer], 2);
    expect(out.map((p) => p.number)).toEqual([2, 1]);
  });

  it("caps output at n, defaulting to QUALITY_SAMPLE_SIZE", () => {
    expect(QUALITY_SAMPLE_SIZE).toBe(5);
    const pulls = Array.from({ length: 8 }, (_, i) =>
      pull({ number: i, additions: i + 1, deletions: 0 }),
    );
    expect(samplePullsForQuality(pulls)).toHaveLength(5);
    expect(samplePullsForQuality(pulls, 3)).toHaveLength(3);
  });

  it("returns a new array and leaves the input array's order untouched", () => {
    const pulls = [
      pull({ number: 1, additions: 2, deletions: 0 }),
      pull({ number: 2, additions: 5000, deletions: 0 }),
      pull({ number: 3, additions: 50, deletions: 0 }),
    ];
    const snapshotOrder = pulls.map((p) => p.number);
    const out = samplePullsForQuality(pulls, 3);
    expect(out).not.toBe(pulls);
    expect(pulls.map((p) => p.number)).toEqual(snapshotOrder);
    // sanity: the output IS actually reordered relative to input (proves ranking ran)
    expect(out.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("empty input yields empty output", () => {
    expect(samplePullsForQuality([])).toEqual([]);
  });
});
