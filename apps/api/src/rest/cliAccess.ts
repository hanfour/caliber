import type { Redis } from "ioredis";
import { cliAccessKey, hashCliAccessToken } from "./deviceAuth.js";

export interface CliPrincipal {
  userId: string;
  orgId: string;
}

export type CliAccessResult =
  | { ok: true; principal: CliPrincipal }
  | { ok: false; error: "unauthorized" | "expired_access_token" };

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return token.startsWith("cct_") ? token : null;
}

export async function authenticateCliAccess(
  redis: Redis,
  authorization: string | undefined,
): Promise<CliAccessResult> {
  const token = bearerToken(authorization);
  if (!token) return { ok: false, error: "unauthorized" };

  const raw = await redis.get(cliAccessKey(hashCliAccessToken(token)));
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<CliPrincipal>) : null;
    if (parsed?.userId && parsed.orgId) {
      return {
        ok: true,
        principal: { userId: parsed.userId, orgId: parsed.orgId },
      };
    }
  } catch {
    // Corrupt or expired Redis state is indistinguishable to the client.
  }
  return { ok: false, error: "expired_access_token" };
}
