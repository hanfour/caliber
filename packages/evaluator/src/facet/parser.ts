import { z } from "zod";

export class FacetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacetParseError";
  }
}

export class FacetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacetValidationError";
  }
}

const FacetSchema = z.object({
  sessionType: z.enum([
    "feature_dev",
    "bug_fix",
    "refactor",
    "exploration",
    "other",
  ]),
  outcome: z.enum(["success", "partial", "failure", "abandoned"]),
  claudeHelpfulness: z.number().int().min(1).max(5),
  frictionCount: z.number().int().nonnegative(),
  bugsCaughtCount: z.number().int().nonnegative(),
  codexErrorsCount: z.number().int().nonnegative(),
  userSatisfaction: z.number().int().min(1).max(5),
});

export type FacetFields = z.infer<typeof FacetSchema>;

const ALLOWED_KEYS: ReadonlyArray<keyof FacetFields> = [
  "sessionType",
  "outcome",
  "claudeHelpfulness",
  "frictionCount",
  "bugsCaughtCount",
  "codexErrorsCount",
  "userSatisfaction",
];

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();

  // Strip code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1];

  // Find first balanced { ... } substring.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return trimmed;
  return trimmed.slice(first, last + 1);
}

export function parseFacet(raw: string): FacetFields {
  const jsonText = extractJsonText(raw);
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FacetParseError(`Invalid JSON: ${msg}`);
  }

  // Strip extra fields manually so unknown keys don't fail validation.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const cleaned: Record<string, unknown> = {};
    for (const k of ALLOWED_KEYS) {
      if (k in (data as Record<string, unknown>)) {
        cleaned[k] = (data as Record<string, unknown>)[k];
      }
    }
    data = cleaned;
  }

  const result = FacetSchema.safeParse(data);
  if (!result.success) {
    throw new FacetValidationError(
      `Facet validation failed: ${result.error.message}`,
    );
  }
  return result.data;
}
