import { TRPCError } from "@trpc/server";

// Centralizes the CREDENTIAL_ENCRYPTION_KEY presence check. The env schema
// requires this key whenever the gateway is enabled, so reaching the throw
// branch indicates a misconfiguration upstream — guard so we never call
// encryptCredential with undefined.
export function requireMasterKeyHex(env: {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "CREDENTIAL_ENCRYPTION_KEY not configured",
    });
  }
  return key;
}

// Shape the UI-supplied credential string into the JSON envelope the gateway
// expects. `resolveCredential` (apps/gateway/src/runtime/resolveCredential.ts)
// discriminates on a top-level `type` field and reads typed sub-fields off
// the same object — passing the user's raw string (either a bare `sk-ant-...`
// or an untagged OAuth JSON blob) would fail with `CredentialFormatError` at
// every request.
export function buildCredentialPlaintext(
  type: "api_key" | "oauth",
  input: string,
): string {
  if (type === "api_key") {
    return JSON.stringify({ type: "api_key", api_key: input });
  }
  // oauth — merge user-pasted `{ access_token, refresh_token, expires_at, ... }`
  // with the authoritative `type: "oauth"` discriminator.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be valid JSON",
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be a JSON object",
    });
  }
  // Closes #73: the form hint is permissive about expires_at format
  // (ISO string OR unix ms OR unix seconds), but the gateway runtime's
  // `resolveCredential` only accepts ISO. Normalize at insert time so
  // the stored shape is always ISO regardless of what the operator
  // pasted.
  const merged: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    type: "oauth",
  };
  const canonicalExpiresAt = parseOauthExpiresAt(input);
  if (canonicalExpiresAt !== null) {
    merged.expires_at = canonicalExpiresAt.toISOString();
  }
  return JSON.stringify(merged);
}

// Parse `expires_at` from an oauth credential payload. Accepts either an ISO
// 8601 string or a unix timestamp (seconds OR milliseconds). Returns null if
// missing or unparseable — caller decides whether that's acceptable.
export function parseOauthExpiresAt(credentialsJson: string): Date | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "oauth credentials must be valid JSON",
    });
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>).expires_at;
  if (raw == null) return null;
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: anything below 10^12 is treated as seconds, otherwise ms.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms);
  }
  return null;
}
