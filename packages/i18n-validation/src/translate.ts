import type { ValidationMessages } from "./messages.js";

/**
 * Build a wire-form validation message that carries runtime `{name}`
 * substitution params alongside a `validation.*` key. The result is a
 * single string of shape `<key>#<urlencoded-json>` that survives every
 * boundary (react-hook-form `FieldError.message`, `ZodError.flatten()`,
 * tRPC wire) intact. `translateValidationKey()` decodes it at the
 * rendering boundary.
 *
 * No params (or `{}`) returns the bare key — keeps the wire form clean
 * for the common static-key case.
 */
export function formatValidationKey(
  key: string,
  params?: Record<string, string | number>,
): string {
  if (!params || Object.keys(params).length === 0) return key;
  return `${key}#${encodeURIComponent(JSON.stringify(params))}`;
}

/**
 * Resolve a `validation.*`-prefixed key against the loaded catalogue.
 * Returns the input verbatim if it isn't a key, the catalogue path doesn't
 * resolve, or the resolved value isn't a string. Quiet (no warn) — call
 * sites that care about misses do their own logging.
 *
 * Mirrors the `lookup()` helper in `errorMap.ts` but kept separate because
 * this is the boundary-translation path: when a Zod schema supplies an
 * explicit `message` to `.min(N, key)` / `.refine(..., {message: key})`,
 * `makeIssue()` bypasses the global errorMap and the raw key surfaces.
 * Client (react-hook-form resolver) and server (tRPC errorFormatter) both
 * use this helper to translate at the rendering boundary.
 *
 * If `raw` has the shape `<key>#<urlencoded-json>` (produced by
 * `formatValidationKey()`), the payload is decoded and `{name}`
 * placeholders in the resolved template are substituted from it.
 *
 * Loud-vs-quiet contract vs `lookup()`: `lookup()` (inside errorMap) WARNS
 * on miss because it runs during schema authoring time when a missing key
 * is almost certainly a developer bug worth surfacing. This helper runs at
 * the rendering boundary AFTER the schema has already accepted the key, so
 * a miss here is a deployment skew (catalogue lagging behind code) — we
 * pass through silently rather than spam every form-submit with warnings.
 */
export function translateValidationKey(
  messages: ValidationMessages,
  raw: string,
): string {
  if (!raw.startsWith("validation.")) return raw;
  const hashIdx = raw.indexOf("#");
  const keyPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const paramsPart = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null;

  const parts = keyPart.split(".");
  let cursor: unknown = messages;
  for (const p of parts) {
    if (cursor !== null && typeof cursor === "object" && p in cursor) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return raw;
    }
  }
  if (typeof cursor !== "string") return raw;
  const template = cursor;

  if (paramsPart === null) return template;

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(decodeURIComponent(paramsPart));
  } catch {
    return template;
  }
  let out = template;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}
