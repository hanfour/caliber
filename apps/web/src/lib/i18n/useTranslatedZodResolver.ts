"use client";

import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale } from "next-intl";
import {
  loadValidationMessages,
  isLocale,
  DEFAULT_LOCALE,
  translateValidationKey,
  type ValidationMessages,
} from "@caliber/i18n-validation";
import type { z } from "zod";
import type { Resolver } from "react-hook-form";

/**
 * react-hook-form resolver that runs the schema through zodResolver, then
 * post-processes any `validation.*`-prefixed messages into the active
 * locale's translation. Required because Zod's makeIssue() bypasses the
 * global errorMap whenever a schema supplies an explicit message — so the
 * keys we set via .min(N, "validation...")/.refine(..., {message: "..."})
 * would otherwise surface raw.
 *
 * Until the messages JSON loads, the wrapper short-circuits to the bare
 * zodResolver (initial render shows raw keys for ~1 paint — acceptable
 * transitional state mirroring the ValidationErrorMapProvider design).
 *
 * Performance: the wrapped resolver is memoised against `[schema, messages]`.
 * If callers construct the Zod schema inline on each render (i.e. the schema
 * reference changes every render), the inner `zodResolver(schema)` rebuilds
 * each time — same overhead as bare `zodResolver(schema)` would have. For
 * best performance, memoise the schema at module scope or via `useMemo`.
 */
export function useTranslatedZodResolver<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
): Resolver<z.infer<TSchema>> {
  const rawLocale = useLocale();
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const [messages, setMessages] = useState<ValidationMessages | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadValidationMessages(locale).then((m) => {
      if (!cancelled) setMessages(m);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return useMemo(() => {
    const base = zodResolver(schema) as Resolver<z.infer<TSchema>>;
    const wrapped: Resolver<z.infer<TSchema>> = async (
      values,
      ctx,
      options,
    ) => {
      const result = await base(values, ctx, options);
      if (!messages || !result.errors) return result;
      return {
        ...result,
        errors: translateFieldErrors(
          result.errors as Record<string, unknown>,
          messages,
        ) as typeof result.errors,
      };
    };
    return wrapped;
  }, [schema, messages]);
}

/**
 * Recursively walk a react-hook-form FieldErrors tree and translate any
 * leaf `message` values that are `validation.*`-prefixed keys. Doesn't
 * mutate inputs.
 */
function translateFieldErrors(
  errors: Record<string, unknown>,
  messages: ValidationMessages,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(errors)) {
    out[key] = translateNode(value, messages);
  }
  return out;
}

function translateNode(node: unknown, messages: ValidationMessages): unknown {
  if (node === null || typeof node !== "object") return node;
  // Arrays arise from z.array() / useFieldArray error trees — recurse into each element.
  if (Array.isArray(node)) {
    return node.map((item) => translateNode(item, messages));
  }
  // Guard against DOM nodes and other non-plain objects (e.g. HTMLTextAreaElement)
  // whose enumerable properties form circular structures that overflow the stack.
  // react-hook-form FieldErrors trees contain plain objects and arrays; any node
  // whose prototype is not Object.prototype (and is not an array, handled above)
  // can be returned as-is.
  if (Object.getPrototypeOf(node) !== Object.prototype) return node;
  const obj = node as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "message" && typeof v === "string") {
      next[k] = translateValidationKey(messages, v);
    } else if (v && typeof v === "object") {
      next[k] = translateNode(v, messages);
    } else {
      next[k] = v;
    }
  }
  return next;
}
