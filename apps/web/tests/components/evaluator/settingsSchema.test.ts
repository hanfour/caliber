import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import {
  createErrorMap,
  loadValidationMessages,
  type ValidationMessages,
} from "@caliber/i18n-validation";
import {
  settingsSchema,
  type SettingsFormValues,
} from "@/components/evaluator/settingsSchema";

// Install the en validation errorMap globally. NOTE: Zod's makeIssue()
// bypasses the global errorMap when the schema (or ctx.addIssue) supplies
// an explicit `message` — see node_modules/zod/v3/helpers/parseUtil.js.
// That means `validation.*` keys passed to .refine()/.superRefine()/
// ctx.addIssue surface as the raw key in `issue.message`. UI display
// layers (and SSR locale providers) resolve these keys at render time.
// In tests we resolve them with the small `translate` helper below so
// the regex assertions can match the English text from the catalogue.
let enMessages: ValidationMessages;
beforeAll(async () => {
  enMessages = await loadValidationMessages("en");
  z.setErrorMap(createErrorMap(enMessages));
});

function translate(raw: string | undefined): string {
  if (!raw || !raw.startsWith("validation.")) return raw ?? "";
  const parts = raw.split(".");
  let cursor: unknown = enMessages;
  for (const part of parts) {
    if (cursor !== null && typeof cursor === "object" && part in cursor) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return raw;
    }
  }
  return typeof cursor === "string" ? cursor : raw;
}

// A baseline that satisfies every required boolean/enum field. Individual
// tests override specific fields to exercise Plan 4C cross-field rules.
const baseValues: SettingsFormValues = {
  contentCaptureEnabled: false,
  retentionDaysOverride: null,
  llmEvalEnabled: false,
  llmEvalAccountId: null,
  llmEvalModel: null,
  captureThinking: false,
  rubricId: null,
  leaderboardEnabled: false,
  llmFacetEnabled: false,
  llmFacetModel: null,
  llmMonthlyBudgetUsd: null,
  llmBudgetOverageBehavior: "degrade",
};

describe("settingsSchema", () => {
  it("parses a baseline valid settings object (no facet, no budget)", () => {
    const result = settingsSchema.safeParse(baseValues);
    expect(result.success).toBe(true);
  });

  it("rejects llmFacetEnabled=true when llmEvalEnabled=false", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmFacetEnabled: true,
      llmFacetModel: "claude-haiku-4-5",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("llmFacetEnabled"),
      );
      expect(translate(issue?.message)).toMatch(/requires LLM evaluation/i);
    }
  });

  it("rejects llmFacetEnabled=true when llmFacetModel is null", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("llmFacetModel"),
      );
      expect(translate(issue?.message)).toMatch(/Choose a facet model/i);
    }
  });

  it("accepts llmFacetEnabled=true when llmEvalEnabled=true and a facet model is chosen", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: "claude-haiku-4-5",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finite non-negative budget number", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: 50,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null as budget (unlimited)", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-number, non-null budget value", () => {
    // The schema is z.union([z.number(), z.null()]) — strings should fail.
    // (Negative numbers are validated server-side and by the form's setValueAs
    //  coercion, not by this client-side schema; the union accepts them.)
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: "not-a-number" as unknown as number,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid llmBudgetOverageBehavior", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmBudgetOverageBehavior: "invalid" as unknown as "degrade",
    });
    expect(result.success).toBe(false);
  });

  it("accepts both halt and degrade for llmBudgetOverageBehavior", () => {
    expect(
      settingsSchema.safeParse({
        ...baseValues,
        llmBudgetOverageBehavior: "halt",
      }).success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({
        ...baseValues,
        llmBudgetOverageBehavior: "degrade",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown facet model", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: "claude-bogus-9000" as unknown as "claude-haiku-4-5",
    });
    expect(result.success).toBe(false);
  });
});
