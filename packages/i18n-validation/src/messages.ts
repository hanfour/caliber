import type { Locale } from "./locales.js";

// Locale catalogue shape. New keys go here AND in every locale JSON file.
// The shape is enforced by the parity snapshot test (Task A9) so any
// locale missing or extra key fails CI.
export interface ValidationMessages {
  validation: {
    codes: {
      invalid_type: string;
      required: string;
      invalid_literal: string;
      invalid_union: string;
      invalid_union_discriminator: string;
      invalid_enum_value: string;
      unrecognized_keys: string;
      invalid_arguments: string;
      invalid_return_type: string;
      invalid_date: string;
      not_multiple_of: string;
      not_finite: string;
      invalid_intersection_types: string;
      custom: string;
      invalid_string: {
        email: string;
        url: string;
        uuid: string;
        regex: string;
        datetime: string;
        cuid: string;
        default: string;
      };
      too_small: {
        string: { inclusive: string; exclusive: string };
        number: { inclusive: string; exclusive: string };
        array: { inclusive: string; exclusive: string };
        date: { inclusive: string; exclusive: string };
      };
      too_big: {
        string: { inclusive: string; exclusive: string };
        number: { inclusive: string; exclusive: string };
        array: { inclusive: string; exclusive: string };
        date: { inclusive: string; exclusive: string };
      };
    };
    // PR B fills this. PR A leaves it as an empty record-of-record.
    custom: Record<string, Record<string, string>>;
  };
}

const cache = new Map<Locale, ValidationMessages>();

export async function loadValidationMessages(
  locale: Locale,
): Promise<ValidationMessages> {
  const cached = cache.get(locale);
  if (cached) return cached;
  const mod = (await import(`../messages/${locale}.json`, {
    with: { type: "json" },
  })) as { default: ValidationMessages };
  cache.set(locale, mod.default);
  return mod.default;
}

// Test-only — exposed for tests that need to assert cold-cache behaviour.
export function _resetMessageCacheForTests(): void {
  cache.clear();
}
