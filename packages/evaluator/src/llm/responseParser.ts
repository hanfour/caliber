import { z } from "zod";

export const llmEvidenceSchema = z.object({
  quote: z.string().min(1),
  requestId: z.string().min(1),
  rationale: z.string().min(1),
});

export const llmSectionAdjustmentSchema = z.object({
  sectionId: z.string().min(1),
  adjustment: z.number().gte(-10).lte(10),
  rationale: z.string().min(1),
});

export const reportInsightSchema = z.object({
  sectionId: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
});

export const reportActionSchema = z.object({
  sectionId: z.string().min(1).optional(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
});

export const userAudienceReportSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  strengths: z.array(reportInsightSchema).max(5),
  growthAreas: z
    .array(
      reportInsightSchema.extend({
        action: z.string().min(1),
      }),
    )
    .max(5),
  nextSteps: z.array(reportActionSchema).max(5),
});

export const adminAudienceReportSchema = z.object({
  title: z.string().min(1),
  executiveSummary: z.string().min(1),
  performanceAssessment: z.string().min(1),
  strengths: z.array(reportInsightSchema).max(6),
  concerns: z
    .array(
      reportInsightSchema.extend({
        severity: z.enum(["high", "medium", "low"]),
        evidenceRequestIds: z.array(z.string().min(1)).max(10),
      }),
    )
    .max(6),
  coachingPlan: z
    .array(
      reportActionSchema.extend({
        successMeasure: z.string().min(1),
      }),
    )
    .max(6),
  calibrationNotes: z.array(z.string().min(1)).max(6),
  dataLimitations: z.array(z.string().min(1)).max(6),
});

export const llmResponseSchema = z.object({
  userReport: userAudienceReportSchema,
  adminReport: adminAudienceReportSchema,
  evidence: z.array(llmEvidenceSchema),
  sectionAdjustments: z.array(llmSectionAdjustmentSchema),
});

export type LlmEvidence = z.infer<typeof llmEvidenceSchema>;
export type LlmSectionAdjustment = z.infer<typeof llmSectionAdjustmentSchema>;
export type ReportInsight = z.infer<typeof reportInsightSchema>;
export type ReportAction = z.infer<typeof reportActionSchema>;
export type UserAudienceReport = z.infer<typeof userAudienceReportSchema>;
export type AdminAudienceReport = z.infer<typeof adminAudienceReportSchema>;
export type LlmResponse = z.infer<typeof llmResponseSchema>;

export type ParseResult =
  | ({ ok: true } & LlmResponse)
  | { ok: false; error: string };

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

export function parseLlmResponse(input: unknown): ParseResult {
  const candidate = coerceToObject(input);
  if (candidate === null) {
    return { ok: false, error: "Input is not a JSON object or JSON string" };
  }

  const result = llmResponseSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, ...result.data };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined; // JSON.parse never yields undefined for valid input
  }
}

function coerceToObject(input: unknown): unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    // 1. Whole string is a ```json fence or bare JSON.
    const direct = tryParse(trimmed.replace(FENCE, "$1").trim());
    if (direct !== undefined) return direct;
    // 2. Model wrapped the JSON in prose ("Here is the report: {…}") or a
    //    non-anchored fence. Extract the outermost {…} object and parse that.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
      const embedded = tryParse(trimmed.slice(first, last + 1));
      if (embedded !== undefined) return embedded;
    }
    return null;
  }
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return null;
  if (Array.isArray(input)) return null;
  return input;
}
