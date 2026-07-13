import type { Section } from "../rubric/schema.js";
import type { SectionResult, SignalHit } from "./types.js";

const DEFAULT_MIN_SAMPLES = 5;

export interface Curve {
  zeroAt: number;
  fullAt: number;
}

/** Linear map value→[0,1]; descending curves (zeroAt > fullAt) invert automatically. */
export function curveScore(value: number, curve: Curve): number {
  const t = (value - curve.zeroAt) / (curve.fullAt - curve.zeroAt);
  return Math.min(1, Math.max(0, t));
}

function parseWeight(w: string): number {
  return Number(w.replace("%", ""));
}

function isFacetSignal(type: SignalHit["type"]): boolean {
  return type.startsWith("facet_");
}

/**
 * Score a continuous-mode section (design: docs/RUBRIC_V2_DESIGN.md §4).
 *
 * - usable facet signal   ⇔ sampleCount >= (section.minSamples ?? 5)
 * - usable non-facet      ⇔ sampleCount undefined or > 0
 * - score = scaleMax × Σ(points×subscore over usable) / Σ(points over usable)
 * - usable points < half of configured points → score: null (insufficient data)
 */
export function scoreSectionContinuous(
  section: Section,
  hits: SignalHit[],
  scaleMax: number,
): SectionResult {
  const byId = new Map(section.signals.map((s) => [s.id, s]));
  const minSamples = section.minSamples ?? DEFAULT_MIN_SAMPLES;

  let totalPoints = 0;
  let usablePoints = 0;
  let earnedSum = 0;

  const annotated: SignalHit[] = hits.map((h) => {
    const sig = byId.get(h.id);
    if (!sig || sig.points === undefined || sig.curve === undefined) return h;

    totalPoints += sig.points;
    const samples = h.sampleCount;
    const usable = isFacetSignal(h.type)
      ? (samples ?? 0) >= minSamples
      : samples === undefined || samples > 0;

    if (!usable) return { ...h, maxPoints: sig.points };

    const subscore = curveScore(h.value ?? 0, sig.curve);
    const earned = sig.points * subscore;
    usablePoints += sig.points;
    earnedSum += earned;
    return { ...h, earnedPoints: earned, maxPoints: sig.points };
  });

  const insufficient = totalPoints === 0 || usablePoints < totalPoints / 2;
  const score = insufficient
    ? null
    : scaleMax * (earnedSum / usablePoints);

  return {
    sectionId: section.id,
    name: section.name,
    weight: parseWeight(section.weight),
    mode: "continuous",
    standardScore: 0,
    superiorScore: scaleMax,
    score,
    maxScore: scaleMax,
    label: insufficient ? "insufficient_data" : "continuous",
    signals: annotated,
  };
}
