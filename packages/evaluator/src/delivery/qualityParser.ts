/**
 * Pure response parser for the LLM delivery-quality layer (PR3 Task 4).
 * No I/O. Coerces a raw LLM reply (bare JSON / ```json fenced / prose-
 * wrapped) the same way llm/responseParser.ts does — reimplemented small
 * and locally here so delivery/ stays self-contained — then zod-validates
 * and clamps into a safe, bounded shape.
 *
 * narrative + qualityAdjustment are load-bearing: if either is missing or
 * malformed, the whole response is rejected (ok:false). evidence is
 * best-effort: a missing/malformed evidence array, or individual
 * malformed items within it, never fail the response — they're just
 * dropped, since evidence only supports the narrative/adjustment.
 */
import { z } from "zod";

export const QUALITY_ADJUSTMENT_LIMIT = 15;

const MAX_EVIDENCE_ITEMS = 5;
const MAX_QUOTE_CHARS = 200;

export interface QualityEvidenceItem {
  repo: string;
  prNumber: number;
  quote: string;
  reason: string;
}

export type QualityParseResult =
  | {
      ok: true;
      qualityAdjustment: number;
      narrative: string;
      evidence: QualityEvidenceItem[];
    }
  | { ok: false; error: string };

const responseSchema = z.object({
  qualityAdjustment: z.number(),
  narrative: z.string().min(1),
  // Validated/filtered item-by-item in coerceEvidence — kept loose here so
  // a malformed evidence field never fails the whole (load-bearing) response.
  evidence: z.unknown().optional(),
});

const evidenceItemSchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number(),
  quote: z.string().min(1),
  reason: z.string().min(1),
});

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

export function parseDeliveryQualityResponse(raw: string): QualityParseResult {
  const candidate = coerceToObject(raw);
  if (candidate === null) {
    return { ok: false, error: "Response is not a JSON object" };
  }

  const result = responseSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }

  const qualityAdjustment = clamp(
    result.data.qualityAdjustment,
    -QUALITY_ADJUSTMENT_LIMIT,
    QUALITY_ADJUSTMENT_LIMIT,
  );

  return {
    ok: true,
    qualityAdjustment,
    narrative: result.data.narrative,
    evidence: coerceEvidence(result.data.evidence),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceEvidence(raw: unknown): QualityEvidenceItem[] {
  if (!Array.isArray(raw)) return [];

  const items: QualityEvidenceItem[] = [];
  for (const entry of raw) {
    if (items.length >= MAX_EVIDENCE_ITEMS) break;
    const parsed = evidenceItemSchema.safeParse(entry);
    if (!parsed.success) continue;
    items.push({
      repo: parsed.data.repo,
      prNumber: parsed.data.prNumber,
      quote: parsed.data.quote.slice(0, MAX_QUOTE_CHARS),
      reason: parsed.data.reason,
    });
  }
  return items;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined; // JSON.parse never yields undefined for valid input
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceToObject(input: string): unknown {
  const trimmed = input.trim();
  // 1. Whole string is a ```json fence or bare JSON.
  const direct = tryParse(trimmed.replace(FENCE, "$1").trim());
  if (direct !== undefined && isPlainObject(direct)) return direct;
  // 2. Model wrapped the JSON in prose ("Here is my assessment: {…}") or a
  //    non-anchored fence. Extract the outermost {…} object and parse that.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const embedded = tryParse(trimmed.slice(first, last + 1));
    if (embedded !== undefined && isPlainObject(embedded)) return embedded;
  }
  return null;
}
