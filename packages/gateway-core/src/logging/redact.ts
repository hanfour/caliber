// API-key migration plan Phase 3 #4-a — credential / token / secret
// redaction for application logs.
//
// Two layers:
//
//   1. `LOG_REDACT_PATHS` — feed to pino's `redact.paths`. Pino replaces
//      matching object paths with `[REDACTED]` before serialisation. Only
//      catches structured fields whose path is known; doesn't help for
//      free-form strings (e.g. an err.message that quoted the failing
//      Bearer token verbatim).
//
//   2. `maskCredentialMaterial(text)` — regex strip for the free-form
//      string case. Pattern-matches the credential shapes the gateway
//      handles today and replaces them with `[REDACTED-XXX]` so the
//      surrounding context is preserved (operator can still tell e.g.
//      "the OpenAI token endpoint rejected our key" without leaking the
//      key itself). Apply at the boundary between library / upstream
//      error messages and our log/persistence layer.

/**
 * Pino redact path list. Covers structured fields where credential
 * material is most likely to land — request/response headers, decoded
 * credential objects, OAuth token sets, cookie headers, env-style keys.
 *
 * Path syntax: pino accepts dotted paths with `*` wildcards.  See
 * https://getpino.io/#/docs/redaction.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  // Request/response auth headers (Fastify exposes both upstream + gateway sides)
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  "res.headers.authorization",
  'res.headers["set-cookie"]',
  // Common credential / token field names anywhere in the log object tree
  "*.password",
  "*.api_key",
  "*.apiKey",
  "*.access_token",
  "*.accessToken",
  "*.refresh_token",
  "*.refreshToken",
  "*.id_token",
  "*.idToken",
  "*.secret",
  "*.client_secret",
  "*.clientSecret",
  "*.credential",
  "*.credentials",
  // Gateway-issued raw key (only ever seen at issue/reveal time; never logged
  // intentionally but redact in case an error path sweeps the surrounding obj)
  "*.rawApiKey",
  // Encryption / hashing material — should never appear in logs but cheap to defend
  "*.masterKeyHex",
  "*.encryptionKey",
  "*.pepper",
];

const REDACT_PLACEHOLDER = "[REDACTED]";

/**
 * Each entry is `{ regex, replacement }`. Order matters: more-specific
 * prefixes (sk-ant-, sk-proj-) are listed before the generic sk- shape so
 * the placeholder can convey which credential type was matched. Replacement
 * keeps a short tag so log readers know "something was elided here" rather
 * than seeing a string just disappear.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  replacement: string;
}> = [
  // Anthropic API keys
  { regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED-ANTHROPIC-KEY]" },
  // OpenAI project / service-account keys (sk-proj-..., sk-svcacct-...)
  {
    regex: /sk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED-OPENAI-KEY]",
  },
  // Generic OpenAI sk- keys (must run after the more-specific prefixes)
  { regex: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED-OPENAI-KEY]" },
  // Gateway-issued user keys (ak_ prefix, 64 hex chars)
  { regex: /ak_[A-Za-z0-9]{40,}/g, replacement: "[REDACTED-GATEWAY-KEY]" },
  // Authorization: Bearer <token>
  {
    regex: /Bearer\s+[A-Za-z0-9._-]{16,}/g,
    replacement: "Bearer [REDACTED-BEARER]",
  },
  // ChatGPT OAuth long-lived refresh token shape
  // (Codex CLI emits these; safe to redact when echoed in errors).
  {
    regex: /\beyJ[A-Za-z0-9_.-]{40,}/g,
    replacement: "[REDACTED-JWT]",
  },
];

/**
 * Strip credential-shaped substrings from a free-form text. Use at the
 * boundary between an upstream-library error message and our log/audit
 * layer.
 *
 * Idempotent: running it twice is safe (the placeholders don't match the
 * patterns). Cheap enough to apply on every error path; benchmarks at ~3μs
 * for a 1KB string with no matches, ~8μs for a 1KB string with three
 * substitutions (Node 22, M1).
 */
export function maskCredentialMaterial(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { regex, replacement } of CREDENTIAL_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

/**
 * Convenience wrapper: pull a string out of an unknown error and mask it.
 * Mirrors the common `err instanceof Error ? err.message : String(err)`
 * idiom that appears across the gateway's error-handling boundaries.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return maskCredentialMaterial(raw);
}

export { REDACT_PLACEHOLDER };
