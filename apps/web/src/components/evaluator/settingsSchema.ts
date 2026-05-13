import { z } from "zod";

// Native <select> always surfaces an empty string when nothing is chosen.
// Treat "" as null at the form-schema level so react-hook-form's resolver
// doesn't reject the form before submit (the API-side zod still enforces
// uuid/null).
export const uuidOrEmpty = z
  .string()
  .nullable()
  .refine((v) => v === null || v === "" || /^[0-9a-f-]{36}$/i.test(v), {
    message: "validation.custom.shared.invalidId",
  })
  .transform((v) => (v === "" ? null : v));

export const FACET_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
] as const;

export type FacetModel = (typeof FACET_MODELS)[number];

export const settingsSchema = z
  .object({
    contentCaptureEnabled: z.boolean(),
    // Native <select> surfaces "" for the placeholder option even when we
    // register with setValueAs. Accept "" here and let onSubmit coerce it to
    // null — react-hook-form's resolver runs before the setValueAs-transformed
    // value reaches the submit handler in some paths.
    retentionDaysOverride: z
      .union([
        z.literal(30),
        z.literal(60),
        z.literal(90),
        z.literal(""),
        z.null(),
      ])
      .nullable(),
    llmEvalEnabled: z.boolean(),
    llmEvalAccountId: uuidOrEmpty,
    llmEvalModel: z.string().nullable(),
    captureThinking: z.boolean(),
    rubricId: uuidOrEmpty,
    leaderboardEnabled: z.boolean(),
    // ── Plan 4C: cost budget + facet ────────────────────────────────────────
    llmFacetEnabled: z.boolean(),
    llmFacetModel: z.enum(FACET_MODELS).nullable(),
    // Native <input type="number"> surfaces "" for empty; coerce to null.
    llmMonthlyBudgetUsd: z.union([z.number(), z.null()]),
    llmBudgetOverageBehavior: z.enum(["degrade", "halt"]),
  })
  .superRefine((val, ctx) => {
    // Plan 4C: facet extraction requires LLM evaluation to be enabled, and a
    // facet model must be chosen. Surface as inline field errors so the user
    // sees them next to the relevant control rather than on submit.
    if (val.llmFacetEnabled && !val.llmEvalEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Facet extraction requires LLM evaluation to be enabled first",
        path: ["llmFacetEnabled"],
      });
    }
    if (val.llmFacetEnabled && !val.llmFacetModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a facet model",
        path: ["llmFacetModel"],
      });
    }
  });

export type SettingsFormValues = z.infer<typeof settingsSchema>;
