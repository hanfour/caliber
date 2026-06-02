// Plan 4A §4.5 — write the supplementary billing snapshot row after a
// successful dispatch.  This is NOT the dedup mechanism (that is the Redis
// idempotency cache); this row is a durable billing/refund audit trail keyed
// by (api_key_id, raw X-Request-Id) retained ~1h.
//
// Design notes:
//   - Fire-and-forget: returns void; never throws (all errors swallowed).
//   - ttlSec === 0 → disabled, no row written.
//   - ON CONFLICT (api_key_id, request_id) DO UPDATE: last-write wins — when
//     the same key arrives twice (e.g. a retry that slipped past the Redis
//     cache), the row reflects the latest dispatch's cost snapshot.
//   - `now` is injectable for deterministic unit tests.

import type { Database } from "@caliber/db";
import { idempotencyRecords } from "@caliber/db";

export interface IdempotencyRecordPayload {
  apiKeyId: string;
  orgId: string;
  userId: string;
  requestId: string; // the gateway-internal req.id
  requestedModel: string;
  surface: string;
  platform: string;
  statusCode: number;
  totalCost: string;
  actualCostUsd: string;
}

export interface WriteIdempotencyRecordInput {
  db: Database;
  requestKey: string; // the raw client X-Request-Id
  ttlSec: number;
  payload: IdempotencyRecordPayload;
  now?: () => Date;
}

export function writeIdempotencyRecord(input: WriteIdempotencyRecordInput): void {
  if (input.ttlSec === 0) return;
  const now = input.now ?? (() => new Date());
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + input.ttlSec * 1000);
  const p = input.payload;
  const values = {
    apiKeyId: p.apiKeyId,
    requestId: input.requestKey,
    internalRequestId: p.requestId,
    orgId: p.orgId,
    userId: p.userId,
    requestedModel: p.requestedModel,
    surface: p.surface,
    platform: p.platform,
    statusCode: p.statusCode,
    totalCost: p.totalCost,
    actualCostUsd: p.actualCostUsd,
    createdAt,
    expiresAt,
  };
  try {
    void input.db
      .insert(idempotencyRecords)
      .values(values)
      .onConflictDoUpdate({
        target: [idempotencyRecords.apiKeyId, idempotencyRecords.requestId],
        set: {
          internalRequestId: values.internalRequestId,
          orgId: values.orgId,
          userId: values.userId,
          requestedModel: values.requestedModel,
          surface: values.surface,
          platform: values.platform,
          statusCode: values.statusCode,
          totalCost: values.totalCost,
          actualCostUsd: values.actualCostUsd,
          createdAt: values.createdAt,
          expiresAt: values.expiresAt,
        },
      })
      .catch(() => {});
  } catch {
    // synchronous throw (e.g. malformed db stub) — swallow per never-throws contract.
  }
}
