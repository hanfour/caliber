import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { upstreamAccounts } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";

// The temp-unschedulable reason the gateway stamps when an api_key credential
// is rejected upstream (401/403). Used to reason-gate the recovery below so a
// rotate can only clear a pause WE set — not an oauth/rate-limit/overload one.
const API_KEY_INVALID_CREDENTIAL_REASON = "api_key_invalid_credential";

// Recover an account that the gateway degraded for a dead api_key credential.
// Called from rotate / rotateOwn AFTER a successful credential_vault reseal.
//
// 1. DB clear is REASON-GATED — only clears the temp fields when the current
//    reason is `api_key_invalid_credential`, so it can't stomp a concurrent
//    oauth-refresh / rate-limit / overload pause on the same row.
// 2. Redis side is BEST-EFFORT — DEL the `authfail:<id>` counter and SET a
//    short `authgrace:<id>` window so in-flight requests still carrying the
//    OLD credential can't immediately re-degrade the freshly-rotated account.
//    Never fail a rotate on a redis hiccup: the next upstream 2xx clears the
//    counter anyway and the grace is only an optimization.
export async function resetApiKeyCredentialHealth(
  ctx: { db: Database; redis: Redis; env: ServerEnv },
  accountId: string,
): Promise<void> {
  await ctx.db
    .update(upstreamAccounts)
    .set({
      tempUnschedulableUntil: null,
      tempUnschedulableReason: null,
      errorMessage: null,
    })
    .where(
      and(
        eq(upstreamAccounts.id, accountId),
        eq(
          upstreamAccounts.tempUnschedulableReason,
          API_KEY_INVALID_CREDENTIAL_REASON,
        ),
      ),
    );

  try {
    await ctx.redis.del(authFailKey(accountId));
    await ctx.redis.set(
      authGraceKey(accountId),
      "1",
      "EX",
      ctx.env.GATEWAY_UPSTREAM_AUTH_GRACE_SEC,
    );
  } catch {
    // grace/counter are an optimization; the next upstream 2xx clears the
    // counter anyway. Swallow so a redis blip never fails a credential rotate.
  }
}

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
