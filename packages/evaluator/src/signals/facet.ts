import type { SignalResult } from "./types.js";

/**
 * Subset of `FacetRow` (from `@caliber/evaluator/facet/extractor`) consumed by
 * facet-based signal aggregators. We accept this narrower shape (rather than
 * the full FacetRow) so callers can pass either the live extractor output or
 * lightweight test fixtures without coupling the signals layer to the storage
 * schema.
 *
 * Rows whose `extractionError !== null` should be persisted with all six
 * payload fields set to `null`; nulls are naturally excluded from aggregation.
 */
export interface FacetRowInput {
  sessionType: string | null;
  outcome: string | null;
  claudeHelpfulness: number | null;
  frictionCount: number | null;
  bugsCaughtCount: number | null;
  codexErrorsCount: number | null;
  userSatisfaction: number | null;
}

interface MeanGteInput {
  rows: FacetRowInput[];
  gte: number;
}

interface MeanLteInput {
  rows: FacetRowInput[];
  lte: number;
}

interface SumGteInput {
  rows: FacetRowInput[];
  gte: number;
  normalize?: "per_session";
}

interface SumLteInput {
  rows: FacetRowInput[];
  lte: number;
  normalize?: "per_session";
}

interface RatioGteInput {
  rows: FacetRowInput[];
  gte: number;
}

export type SessionType =
  | "feature_dev"
  | "bug_fix"
  | "refactor"
  | "exploration"
  | "other";

export interface SessionTypeRatioInput {
  rows: FacetRowInput[];
  targetType: SessionType;
  gte: number;
}

/**
 * Mean `claudeHelpfulness` across rows that have a numeric value (1-5 scale).
 * `hit: true` when mean >= gte. Empty/all-null inputs return `hit: false`,
 * matching the convention of `iterationCount` (no data → no hit).
 */
export function collectFacetClaudeHelpfulness(
  input: MeanGteInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.claudeHelpfulness)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return { hit: mean >= input.gte, value: mean, evidence: [], sampleCount: present.length };
}

/**
 * Mean `frictionCount` per session — *inverted threshold* (lower is better),
 * mirroring `collectRefusalRate`'s `lte` convention. `hit: true` when
 * mean <= lte.
 *
 * Empty/all-null returns `hit: true, value: 0` to match `refusalRate`'s
 * "no data is fine" inverted-threshold semantic — absence of friction signal
 * is not failure of the section.
 */
export function collectFacetFrictionPerSession(
  input: MeanLteInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.frictionCount)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: true, value: 0, evidence: [], sampleCount: 0 };
  }

  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return { hit: mean <= input.lte, value: mean, evidence: [], sampleCount: present.length };
}

/**
 * Sum of `bugsCaughtCount` across rows. `hit: true` when sum >= gte.
 * If normalize: "per_session", divides by the count of rows with data.
 */
export function collectFacetBugsCaught(input: SumGteInput): SignalResult {
  const present = input.rows
    .map((r) => r.bugsCaughtCount)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const sum = present.reduce((a, b) => a + b, 0);
  const value = input.normalize === "per_session" ? sum / present.length : sum;
  return { hit: value >= input.gte, value, evidence: [], sampleCount: present.length };
}

/**
 * Sum of `codexErrorsCount` — *inverted threshold* (lower is better).
 * `hit: true` when sum <= lte. Same `refusalRate`-style semantics as
 * `collectFacetFrictionPerSession`: empty/all-null returns `hit: true`.
 * If normalize: "per_session", divides by the count of rows with data.
 */
export function collectFacetCodexErrors(input: SumLteInput): SignalResult {
  const present = input.rows
    .map((r) => r.codexErrorsCount)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: true, value: 0, evidence: [], sampleCount: 0 };
  }

  const sum = present.reduce((a, b) => a + b, 0);
  const value = input.normalize === "per_session" ? sum / present.length : sum;
  return { hit: value <= input.lte, value, evidence: [], sampleCount: present.length };
}

/**
 * Outcome success ratio = count(outcome === "success" || "partial")
 *                       / count(rows with non-null outcome).
 * `hit: true` when ratio >= gte. Empty/all-null returns `hit: false`.
 */
export function collectFacetOutcomeSuccessRate(
  input: RatioGteInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.outcome)
    .filter((v): v is string => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const wins = present.filter(
    (o) => o === "success" || o === "partial",
  ).length;
  const ratio = wins / present.length;
  return { hit: ratio >= input.gte, value: ratio, evidence: [], sampleCount: present.length };
}

/**
 * Mean `userSatisfaction` across rows with a numeric value (1-5 scale, v2).
 * `hit: true` when mean >= gte. Empty/all-null → hit:false.
 */
export function collectFacetUserSatisfaction(
  input: MeanGteInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.userSatisfaction)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return { hit: mean >= input.gte, value: mean, evidence: [], sampleCount: present.length };
}

/**
 * Session-type ratio = count(sessionType === targetType)
 *                    / count(rows with non-null sessionType).
 * `hit: true` when ratio >= gte. Useful for "iterative engagement" superior
 * thresholds (e.g. >=30% feature_dev sessions). Empty/all-null returns
 * `hit: false`.
 */
export function collectFacetSessionTypeRatio(
  input: SessionTypeRatioInput,
): SignalResult {
  const present = input.rows
    .map((r) => r.sessionType)
    .filter((v): v is string => v !== null);

  if (present.length === 0) {
    return { hit: false, value: 0, evidence: [], sampleCount: 0 };
  }

  const matches = present.filter((t) => t === input.targetType).length;
  const ratio = matches / present.length;
  return { hit: ratio >= input.gte, value: ratio, evidence: [], sampleCount: present.length };
}
