import type { ValidationMessages } from "./messages.js";

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
  const parts = raw.split(".");
  let cursor: unknown = messages;
  for (const p of parts) {
    if (cursor !== null && typeof cursor === "object" && p in cursor) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return raw;
    }
  }
  return typeof cursor === "string" ? cursor : raw;
}
