/**
 * Delivery score assembly (spec 2026-07-15 Component 3). Pure.
 * Reuses curveScore (linear, auto-inverting). Weight renormalization
 * over scorable sections mirrors the rule engine's Σweight-of-present
 * convention; insufficient data yields null total, never zero.
 */
import { curveScore } from "../engine/continuousScorer.js";
import {
  DELIVERY_MIN_EVENTS,
  DELIVERY_RUBRIC_V1,
  DELIVERY_RUBRIC_VERSION,
  DELIVERY_SCALE_MAX,
  DELIVERY_SECTION_WEIGHTS,
  type DeliveryCurve,
  type DeliveryMetricKey,
  type DeliverySectionKey,
} from "./rubric.js";
import type { DeliveryMetricsResult } from "./metrics.js";

export interface DeliveryMetricScore {
  key: DeliveryMetricKey;
  value: number | null;
  scaledCurve: DeliveryCurve;
  subscore: number | null;
}

export interface DeliverySectionScore {
  key: DeliverySectionKey;
  weight: number;
  score: number | null;
  metrics: DeliveryMetricScore[];
}

export interface DeliveryScoreResult {
  totalScore: number | null;
  insufficientData: boolean;
  rubricVersion: string;
  windowDays: number;
  totalEvents: number;
  sections: DeliverySectionScore[];
}

const SECTION_ORDER: readonly DeliverySectionKey[] = [
  "throughput",
  "collaboration",
  "timeliness",
];

export function scoreDelivery(metrics: DeliveryMetricsResult): DeliveryScoreResult {
  const windowFactor = metrics.windowDays / 30;

  const sections: DeliverySectionScore[] = SECTION_ORDER.map((sectionKey) => {
    const defs = DELIVERY_RUBRIC_V1.filter((d) => d.section === sectionKey);
    const metricScores: DeliveryMetricScore[] = defs.map((def) => {
      const scaledCurve: DeliveryCurve =
        def.kind === "count"
          ? { zeroAt: def.curve.zeroAt, fullAt: def.curve.fullAt * windowFactor }
          : { ...def.curve };
      const raw = metrics.values[def.key];
      return {
        key: def.key,
        value: raw ?? null,
        scaledCurve,
        subscore: raw === undefined ? null : curveScore(raw, scaledCurve),
      };
    });

    const present = metricScores.filter((m) => m.subscore !== null);
    return {
      key: sectionKey,
      weight: DELIVERY_SECTION_WEIGHTS[sectionKey],
      score:
        present.length === 0
          ? null
          : present.reduce((sum, m) => sum + (m.subscore as number), 0) /
            present.length,
      metrics: metricScores,
    };
  });

  const insufficientData = metrics.totalEvents < DELIVERY_MIN_EVENTS;

  const scorable = sections.filter((s) => s.score !== null);
  const weightSum = scorable.reduce((sum, s) => sum + s.weight, 0);
  const weighted =
    weightSum > 0
      ? scorable.reduce((sum, s) => sum + s.weight * (s.score as number), 0) /
        weightSum
      : null;

  const totalScore =
    insufficientData || weighted === null
      ? null
      : Math.round(DELIVERY_SCALE_MAX * weighted * 10) / 10;

  return {
    totalScore,
    insufficientData,
    rubricVersion: DELIVERY_RUBRIC_VERSION,
    windowDays: metrics.windowDays,
    totalEvents: metrics.totalEvents,
    sections,
  };
}
