import type { Section } from "../rubric/schema.js";
import type { SectionResult, SignalHit } from "./types.js";

function parseWeight(w: string): number {
  return Number(w.replace("%", ""));
}

export function shouldScoreSuperior(section: Section, hits: SignalHit[]): boolean {
  const hitIds = new Set(hits.filter((h) => h.hit).map((h) => h.id));
  if (hitIds.size === 0) return false;

  if (section.superiorRules) {
    const { strongThresholds, supportThresholds, minStrongHits, minSupportHits } =
      section.superiorRules;
    const strongMet = strongThresholds.filter((id) => hitIds.has(id)).length;
    const supportMet = supportThresholds.filter((id) => hitIds.has(id)).length;
    return strongMet >= minStrongHits && supportMet >= minSupportHits;
  }

  // No superiorRules → fall back: all signals must hit for superior
  const totalSignals = section.signals.length;
  if (totalSignals === 0) return false;
  return hitIds.size === totalSignals;
}

export function scoreSection(section: Section, hits: SignalHit[]): SectionResult {
  const { standard, superior } = section;
  if (!standard || !superior) {
    throw new Error(
      `tiered section "${section.id}" is missing standard/superior tiers`,
    );
  }

  const weight = parseWeight(section.weight);
  const superiorReached = shouldScoreSuperior(section, hits);
  const score = superiorReached ? superior.score : standard.score;
  const label = superiorReached ? superior.label : standard.label;

  return {
    sectionId: section.id,
    name: section.name,
    weight,
    standardScore: standard.score,
    superiorScore: superior.score,
    score,
    label,
    signals: hits,
  };
}
