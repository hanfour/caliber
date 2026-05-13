import { z, type ZodErrorMap } from "zod";
import type { ValidationMessages } from "./messages.js";

// Walks a dot-path into ValidationMessages and substitutes `{name}` placeholders
// from `params`. Returns the raw key on miss (and emits a tagged warn) so
// gaps are obvious in QA instead of silent.
function lookup(
  messages: ValidationMessages,
  key: string,
  params?: Record<string, string | number>,
): string {
  const parts = key.split(".");
  let cursor: unknown = messages;
  for (const part of parts) {
    if (cursor !== null && typeof cursor === "object" && part in cursor) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[i18n-validation] missing key: ${key}`);
      return key;
    }
  }
  if (typeof cursor !== "string") {
    // eslint-disable-next-line no-console
    console.warn(`[i18n-validation] expected string at: ${key}`);
    return key;
  }
  if (!params) return cursor;
  let out = cursor;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

export function createErrorMap(messages: ValidationMessages): ZodErrorMap {
  return (issue, ctx) => {
    // Allow any issue (including too_small, too_big, invalid_string) to
    // override its translated message by providing a `validation.*`-prefixed
    // key via Zod schema's `message` option (e.g. `.min(1, "validation.custom
    // .shared.nameRequired")`). Without this short-circuit, the per-code
    // branch below would substitute Zod's default code translation and
    // silently ignore the key the caller explicitly set.
    if (typeof issue.message === "string" && issue.message.startsWith("validation.")) {
      return { message: lookup(messages, issue.message) };
    }
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type: {
        if (issue.received === "undefined") {
          return { message: lookup(messages, "validation.codes.required") };
        }
        return {
          message: lookup(messages, "validation.codes.invalid_type", {
            expected: issue.expected,
            received: issue.received,
          }),
        };
      }
      case z.ZodIssueCode.invalid_literal: {
        return {
          message: lookup(messages, "validation.codes.invalid_literal", {
            expected: JSON.stringify(issue.expected),
          }),
        };
      }
      case z.ZodIssueCode.invalid_string: {
        const validation = issue.validation;
        const known = ["email", "url", "uuid", "regex", "datetime", "cuid"] as const;
        type Known = (typeof known)[number];
        if (typeof validation === "string" && (known as readonly string[]).includes(validation)) {
          return {
            message: lookup(
              messages,
              `validation.codes.invalid_string.${validation as Known}`,
            ),
          };
        }
        return {
          message: lookup(messages, "validation.codes.invalid_string.default"),
        };
      }
      case z.ZodIssueCode.too_small: {
        const type =
          issue.type === "string" ||
          issue.type === "number" ||
          issue.type === "array" ||
          issue.type === "date"
            ? issue.type
            : "string";
        const incl = issue.inclusive ? "inclusive" : "exclusive";
        return {
          message: lookup(
            messages,
            `validation.codes.too_small.${type}.${incl}`,
            { minimum: String(issue.minimum) },
          ),
        };
      }
      case z.ZodIssueCode.too_big: {
        const type =
          issue.type === "string" ||
          issue.type === "number" ||
          issue.type === "array" ||
          issue.type === "date"
            ? issue.type
            : "string";
        const incl = issue.inclusive ? "inclusive" : "exclusive";
        return {
          message: lookup(
            messages,
            `validation.codes.too_big.${type}.${incl}`,
            { maximum: String(issue.maximum) },
          ),
        };
      }
      case z.ZodIssueCode.invalid_enum_value: {
        return {
          message: lookup(messages, "validation.codes.invalid_enum_value", {
            options: issue.options.join(", "),
            received: String(issue.received),
          }),
        };
      }
      case z.ZodIssueCode.invalid_union: {
        return { message: lookup(messages, "validation.codes.invalid_union") };
      }
      case z.ZodIssueCode.invalid_union_discriminator: {
        return {
          message: lookup(
            messages,
            "validation.codes.invalid_union_discriminator",
            { options: issue.options.join(", ") },
          ),
        };
      }
      case z.ZodIssueCode.unrecognized_keys: {
        return {
          message: lookup(messages, "validation.codes.unrecognized_keys", {
            keys: issue.keys.join(", "),
          }),
        };
      }
      case z.ZodIssueCode.invalid_arguments: {
        return {
          message: lookup(messages, "validation.codes.invalid_arguments"),
        };
      }
      case z.ZodIssueCode.invalid_return_type: {
        return {
          message: lookup(messages, "validation.codes.invalid_return_type"),
        };
      }
      case z.ZodIssueCode.invalid_date: {
        return { message: lookup(messages, "validation.codes.invalid_date") };
      }
      case z.ZodIssueCode.not_multiple_of: {
        return {
          message: lookup(messages, "validation.codes.not_multiple_of", {
            multipleOf: String(issue.multipleOf),
          }),
        };
      }
      case z.ZodIssueCode.not_finite: {
        return { message: lookup(messages, "validation.codes.not_finite") };
      }
      case z.ZodIssueCode.invalid_intersection_types: {
        return {
          message: lookup(
            messages,
            "validation.codes.invalid_intersection_types",
          ),
        };
      }
      case z.ZodIssueCode.custom: {
        const raw = issue.message ?? ctx.defaultError;
        if (typeof raw === "string" && raw.startsWith("validation.")) {
          return { message: lookup(messages, raw) };
        }
        return { message: ctx.defaultError };
      }
      default:
        return { message: ctx.defaultError };
    }
  };
}
