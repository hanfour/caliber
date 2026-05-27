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

export interface ResolvedDeviceWithStatus extends ResolvedDevice {
  alreadyRevoked: boolean;
}

/**
 * resolveDeviceFromAuthAllowRevoked is the variant used by DELETE /v1/devices/me.
 * Same shape as resolveDeviceFromAuth but short-circuits to ok+alreadyRevoked=true
 * when device.revokedAt is non-null, BEFORE the status !== 'active' check.
 *
 * Rationale: the revoke route SETs both status='revoked' AND revoked_at=NOW(),
 * so a naive shared helper would catch the second DELETE on the status check
 * and return 401 device_inactive. With this sister helper, repeated DELETEs
 * map cleanly to 410 device_already_revoked (idempotent).
 *
 * The AuthFailure variants are narrowed: device_revoked is unreachable here
 * because revoked devices succeed with alreadyRevoked=true instead.
 */
export async function resolveDeviceFromAuthAllowRevoked(
  db: Database,
  env: ServerEnv,
  authHeader: string | undefined,
): Promise<
  | { ok: true; device: ResolvedDeviceWithStatus }
  | { ok: false; error: Exclude<AuthFailure, "device_revoked"> }
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

  // KEY DIFFERENCE vs resolveDeviceFromAuth: deviceRevokedAt short-circuits
  // BEFORE the status check. Otherwise the revoke SQL's status='revoked'
  // update would trip the next check and return device_inactive on the
  // second DELETE call — see DELETE /v1/devices/me route for context.
  if (row.deviceRevokedAt !== null) {
    return {
      ok: true,
      device: {
        deviceId: row.deviceId,
        userId: row.userId,
        orgId: row.orgId,
        alreadyRevoked: true,
      },
    };
  }

  // Not revoked but status non-active (admin freeze etc.) — reject.
  if (row.status !== "active") return { ok: false, error: "device_inactive" };

  return {
    ok: true,
    device: {
      deviceId: row.deviceId,
      userId: row.userId,
      orgId: row.orgId,
      alreadyRevoked: false,
    },
  };
}
