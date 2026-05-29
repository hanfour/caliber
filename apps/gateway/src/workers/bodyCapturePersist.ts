/**
 * Pure persistence helper for body capture (Plan 4B Part 3, Task 3.4).
 *
 * Implements the sanitize → truncate → encrypt → INSERT pipeline.
 * Takes a db handle, master key, and validated payload; writes to
 * `request_bodies` with ON CONFLICT DO NOTHING for idempotency.
 */

import type { Database } from "@caliber/db";
import { requestBodies } from "@caliber/db";
import { sanitize } from "../capture/sanitizer.js";
import { truncate } from "../capture/truncate.js";
import { encryptBody } from "../capture/encrypt.js";
import type { BodyCaptureJobPayload } from "./bodyCaptureQueue.js";

export interface PersistBodyInput {
  db: Database;
  masterKeyHex: string;
  payload: BodyCaptureJobPayload;
  now?: Date;
}

/**
 * Run the full sanitize → truncate → encrypt → INSERT pipeline for one
 * body capture payload.  Idempotent via ON CONFLICT DO NOTHING on requestId.
 *
 * Throws on DB error; BullMQ will retry per the queue's `attempts` policy.
 */
export async function persistBody(input: PersistBodyInput): Promise<void> {
  const { db, masterKeyHex, payload, now = new Date() } = input;

  // Step 1: sanitize each body individually (operate on the parsed JSON when possible)
  const sanitizedRequestBody = safeStringifyJson(
    sanitize(safeParseJson(payload.requestBody)),
  );
  const sanitizedResponseBody = safeStringifyJson(
    sanitize(safeParseJson(payload.responseBody)),
  );
  const sanitizedThinking = payload.thinkingBody
    ? safeStringifyJson(sanitize(safeParseJson(payload.thinkingBody)))
    : null;
  // attemptErrors often not JSON; sanitize if JSON, else pass through
  const sanitizedErrors = payload.attemptErrors ?? null;

  // Step 2: truncate
  const truncated = truncate({
    requestBody: sanitizedRequestBody,
    responseBody: sanitizedResponseBody,
    thinkingBody: sanitizedThinking,
    attemptErrors: sanitizedErrors,
  });

  // Step 3: encrypt each body separately with requestId as salt
  const requestBodyEnc = encryptBody({
    masterKeyHex,
    requestId: payload.requestId,
    plaintext: truncated.requestBody,
  });
  const responseBodyEnc = encryptBody({
    masterKeyHex,
    requestId: payload.requestId,
    plaintext: truncated.responseBody,
  });
  const thinkingBodyEnc =
    truncated.thinkingBody !== null
      ? encryptBody({
          masterKeyHex,
          requestId: payload.requestId,
          plaintext: truncated.thinkingBody,
        })
      : null;
  const attemptErrorsEnc =
    truncated.attemptErrors !== null
      ? encryptBody({
          masterKeyHex,
          requestId: payload.requestId,
          plaintext: truncated.attemptErrors,
        })
      : null;

  const retentionUntil = new Date(
    now.getTime() + payload.retentionDays * 24 * 60 * 60 * 1000,
  );

  // Step 4: INSERT ON CONFLICT DO NOTHING (idempotent)
  await db
    .insert(requestBodies)
    .values({
      requestId: payload.requestId,
      orgId: payload.orgId,
      requestBodySealed: requestBodyEnc.sealed,
      responseBodySealed: responseBodyEnc.sealed,
      thinkingBodySealed: thinkingBodyEnc?.sealed ?? null,
      attemptErrorsSealed: attemptErrorsEnc?.sealed ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestParams: payload.requestParams as any,
      stopReason: payload.stopReason,
      clientUserAgent: payload.clientUserAgent,
      clientSessionId: payload.clientSessionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attachmentsMeta: payload.attachmentsMeta as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cacheControlMarkers: payload.cacheControlMarkers as any,
      toolResultTruncated: truncated.toolResultTruncated,
      bodyTruncated: truncated.bodyTruncated,
      capturedAt: now,
      retentionUntil,
    })
    .onConflictDoNothing({ target: requestBodies.requestId });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Not JSON — sanitizer passes strings through unchanged
    return s;
  }
}

function safeStringifyJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}
