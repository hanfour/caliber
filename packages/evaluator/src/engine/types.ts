import type { Evidence } from "../signals/types.js";
import type { Signal } from "../rubric/schema.js";
import type { Metrics } from "../metrics/aggregator.js";

export interface SignalHit {
  id: string;
  type: Signal["type"];
  hit: boolean;
  value?: number;
  evidence?: Evidence[];
  /** v2: rows that actually carried data for this signal. */
  sampleCount?: number;
  /** v2 continuous: points earned after curve mapping (undefined when unusable). */
  earnedPoints?: number;
  /** v2 continuous: configured points for this signal. */
  maxPoints?: number;
}

export interface SectionResult {
  sectionId: string;
  name: string;
  weight: number; // Parsed from "50%" → 50
  /** v2: which scorer produced this result. Legacy rows lack the field. */
  mode: "tiered" | "continuous";
  standardScore: number;
  superiorScore: number;
  /** null = insufficient data (continuous only). Tiered is always numeric. */
  score: number | null;
  /** v2 continuous: the scale max this section was scored against. */
  maxScore?: number;
  label: string;
  signals: SignalHit[];
}

export interface DataQuality {
  capturedRequests: number;
  missingBodies: number;
  truncatedBodies: number;
  totalRequests: number;
  coverageRatio: number;
}

export interface Report {
  /** Weighted aggregate on the rubric scale (default [0,120]); null = insufficient data. */
  totalScore: number | null;
  insufficientData: boolean;
  sectionScores: SectionResult[];
  signalsSummary: Metrics;
  dataQuality: DataQuality;
}
