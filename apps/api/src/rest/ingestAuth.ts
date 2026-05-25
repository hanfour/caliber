// apps/api/src/rest/ingestAuth.ts
// Shared auth helper for routes that authenticate cda_* device keys
// (POST /v1/ingest, GET /v1/redaction-set).
import { eq } from "drizzle-orm";
import { devices, deviceApiKeys, type Database } from "@caliber/db";
import { hashDeviceKey } from "@caliber/gateway-core";
import type { ServerEnv } from "@caliber/config";

export type AuthFailure =
  | "missing_token"
  | "invalid_token"
  | "key_revoked"
  | "device_revoked"
  | "device_inactive"
  | "server_misconfigured";

export interface ResolvedDevice {
  deviceId: string;
  userId: string;
  orgId: string;
}

export async function resolveDeviceFromAuth(
  db: Database,
  env: ServerEnv,
  authHeader: string | undefined,
): Promise<
  | { ok: true; device: ResolvedDevice }
  | { ok: false; error: AuthFailure }
> {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) return { ok: false, error: "server_misconfigured" };

  if (!authHeader || typeof authHeader !== "string") {
    return { ok: false, error: "missing_token" };
  }
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "missing_token" };
  }
  const raw = authHeader.slice(7).trim();
  if (!raw.startsWith("cda_") || raw.length < 16) {
    return { ok: false, error: "invalid_token" };
  }

  const keyHash = hashDeviceKey(pepper, raw);
  const row = await db
    .select({
      deviceId: deviceApiKeys.deviceId,
      keyRevokedAt: deviceApiKeys.revokedAt,
      userId: devices.userId,
      orgId: devices.orgId,
      status: devices.status,
      deviceRevokedAt: devices.revokedAt,
    })
    .from(deviceApiKeys)
    .innerJoin(devices, eq(devices.id, deviceApiKeys.deviceId))
    .where(eq(deviceApiKeys.keyHash, keyHash))
    .limit(1)
    .then((r) => r[0]);

  if (!row) return { ok: false, error: "invalid_token" };
  if (row.keyRevokedAt !== null) return { ok: false, error: "key_revoked" };
  if (row.deviceRevokedAt !== null) return { ok: false, error: "device_revoked" };
  if (row.status !== "active") return { ok: false, error: "device_inactive" };

  return { ok: true, device: { deviceId: row.deviceId, userId: row.userId, orgId: row.orgId } };
}
