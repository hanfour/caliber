import { z } from "zod";

// Metric names used by `threshold` signals. Aligned with metric aggregator in Task 2.5.
export const metricEnum = z.enum([
  "requests",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_cost",
  "cache_read_ratio",
  "model_diversity",
  "client_mix_ratio",
  "refusal_rate",
  "body_capture_coverage",
  "tool_diversity",
  "iteration_count",
]);

export const curveSchema = z
  .object({ zeroAt: z.number(), fullAt: z.number() })
  .refine((c) => c.zeroAt !== c.fullAt, {
    message: "curve.zeroAt must differ from curve.fullAt",
  });

// Shared continuous scoring fields for all signal variants
const continuousFields = {
  points: z.number().positive().optional(),
  curve: curveSchema.optional(),
};

export const signalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("keyword"),
    id: z.string(),
    in: z.enum(["request_body", "response_body", "both"]),
    terms: z.array(z.string()).min(1),
    caseSensitive: z.boolean().default(false),
    // #261: when set, the signal hits only if at least this FRACTION of bodies
    // contain a term (not just "any body"), so high-volume telemetry doesn't
    // auto-saturate. Absent → legacy any-hit behavior.
    minRatio: z.number().min(0).max(1).optional(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("threshold"),
    id: z.string(),
    metric: metricEnum,
    gte: z.number().optional(),
    lte: z.number().optional(),
    between: z.tuple([z.number(), z.number()]).optional(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("refusal_rate"),
    id: z.string(),
    lte: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("client_mix"),
    id: z.string(),
    expect: z.array(z.string()).min(1),
    minRatio: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("model_diversity"),
    id: z.string(),
    gte: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("cache_read_ratio"),
    id: z.string(),
    gte: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("extended_thinking_used"),
    id: z.string(),
    minCount: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("tool_diversity"),
    id: z.string(),
    gte: z.number(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("iteration_count"),
    id: z.string(),
    gte: z.number(),
    ...continuousFields,
  }),
  // ── Plan 4C — facet-based signals (require ENABLE_FACET_EXTRACTION + per-org
  //    `llm_facet_enabled`; emit `hit: false` cleanly when no facet rows are
  //    present in the window so absence-of-data degrades gracefully).
  z.object({
    type: z.literal("facet_claude_helpfulness"),
    id: z.string(),
    gte: z.number().min(1).max(5),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_friction_per_session"),
    id: z.string(),
    lte: z.number().min(0),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_bugs_caught"),
    id: z.string(),
    gte: z.number().min(0),
    normalize: z.enum(["per_session"]).optional(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_codex_errors"),
    id: z.string(),
    lte: z.number().min(0),
    normalize: z.enum(["per_session"]).optional(),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_outcome_success_rate"),
    id: z.string(),
    gte: z.number().min(0).max(1),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_session_type_ratio"),
    id: z.string(),
    targetType: z.enum([
      "feature_dev",
      "bug_fix",
      "refactor",
      "exploration",
      "other",
    ]),
    gte: z.number().min(0).max(1),
    ...continuousFields,
  }),
  z.object({
    type: z.literal("facet_user_satisfaction"),
    id: z.string(),
    gte: z.number().min(1).max(5),
    ...continuousFields,
  }),
]);

const tierSchema = z.object({
  score: z.number(),
  label: z.string(),
  criteria: z.array(z.string()),
});

export const sectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    weight: z.string().regex(/^\d{1,3}%$/),
    scoring: z.object({ mode: z.enum(["tiered", "continuous"]) }).optional(),
    minSamples: z.number().int().positive().optional(),
    standard: tierSchema.optional(),
    superior: tierSchema.optional(),
    signals: z.array(signalSchema),
    superiorRules: z
      .object({
        strongThresholds: z.array(z.string()),
        supportThresholds: z.array(z.string()),
        minStrongHits: z.number().default(1),
        minSupportHits: z.number().default(1),
      })
      .optional(),
  })
  .superRefine((section, ctx) => {
    const mode = section.scoring?.mode ?? "tiered";
    if (mode === "tiered") {
      if (!section.standard || !section.superior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tiered section requires standard and superior tiers",
        });
      }
      return;
    }
    // continuous: every signal must have points + curve
    for (const [i, sig] of section.signals.entries()) {
      if (sig.points === undefined || sig.curve === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["signals", i],
          message: "continuous section requires points and curve on every signal",
        });
      }
    }
  });

export const rubricSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  locale: z.enum(["en", "zh-Hant", "ja"]).default("en"),
  scale: z
    .object({ max: z.number().positive(), pass: z.number().positive().optional() })
    .optional(),
  sections: z.array(sectionSchema).min(1),
  noiseFilters: z.array(z.string()).optional(),
});

export type Rubric = z.infer<typeof rubricSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Signal = z.infer<typeof signalSchema>;
export type Metric = z.infer<typeof metricEnum>;
