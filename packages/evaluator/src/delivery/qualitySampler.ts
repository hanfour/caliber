/**
 * Pure PR sampler for the LLM delivery-quality layer (PR3 Task 4).
 * No I/O, no mutation — ranks a candidate PR list by an approximate
 * "how much is there to read" score (log-scaled diff size, so a 5000-line
 * PR doesn't drown out everything else) and returns the top n.
 */

export const QUALITY_SAMPLE_SIZE = 5;

export interface QualityPullCandidate {
  repoFullName: string;
  number: number;
  title: string;
  additions: number;
  deletions: number;
  mergedAt: Date;
}

function sizeScore(p: QualityPullCandidate): number {
  return Math.log(p.additions + p.deletions + 1);
}

export function samplePullsForQuality(
  pulls: QualityPullCandidate[],
  n: number = QUALITY_SAMPLE_SIZE,
): QualityPullCandidate[] {
  return [...pulls]
    .sort((a, b) => {
      const diff = sizeScore(b) - sizeScore(a);
      if (diff !== 0) return diff;
      return b.mergedAt.getTime() - a.mergedAt.getTime();
    })
    .slice(0, n);
}
