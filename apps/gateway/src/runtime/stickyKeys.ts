import { createHash } from "node:crypto";

// Header Claude Code sets per conversation (design §4.4). Fastify lowercases
// all incoming header names, so we match the lowercase form.
const SESSION_HEADER = "x-claude-session-id";

/**
 * Derives the Layer 2 sticky key (Plan 5A §8.2) from inbound request headers.
 *
 * Returns a sha256 hex of the `X-Claude-Session-Id` value, or `undefined`
 * when the header is absent/empty — in which case the request carries no
 * session stickiness and the scheduler falls through to Layer 3.
 *
 * Hashing (rather than using the raw id) gives a fixed-length, redis-key-safe
 * token and avoids leaking the client's session id into Redis keys / logs.
 */
export function sessionHashFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers[SESSION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Extracts the Layer 1 sticky key (`previous_response_id`) from a parsed
 * request body (OpenAI Responses / Codex surface). Returns `undefined` when
 * the field is absent or not a non-empty string.
 */
export function previousResponseIdFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as { previous_response_id?: unknown }).previous_response_id;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
