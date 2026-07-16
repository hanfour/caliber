/**
 * BullMQ queue + thin wrapper for evaluator jobs (Plan 4B Part 4, Task 4.1;
 * extracted from apps/gateway/src/workers/evaluator/queue.ts).
 *
 * Design notes:
 *   - Queue name "evaluator" with prefix "caliber:gw" yields Redis keys under
 *     `caliber:gw:evaluator:*`, matching the design-doc identifier.
 *
 *   - Job payload uses ISO 8601 datetime strings (not Date objects) because
 *     BullMQ JSON-serializes payloads. Dates become strings after JSON
 *     round-trip, so being explicit avoids silent coercion bugs in the worker.
 *
 *   - jobId is derived by `buildEvaluatorJobId` (from `@caliber/evaluator`),
 *     producing a colon-free, underscore-joined string. BullMQ 5.x throws
 *     `Custom Id cannot contain :` for ids that contain `:` and don't split
 *     into exactly 3 parts; ISO periodStart has multiple colons and would
 *     trigger that error with a naive template literal. The shared builder is
 *     also used by `apps/api reports.ts` rerun so cron and admin-rerun dedup
 *     correctly against each other.
 */

import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import { buildEvaluatorJobId } from "@caliber/evaluator";
import {
  CALIBER_QUEUE_PREFIX,
  DEFAULT_JOB_OPTIONS,
  buildQueueOptions,
  type QueueConnection,
  type QueueLike,
} from "./shared.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const EVALUATOR_QUEUE_NAME = "evaluator";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `caliber:gw:evaluator:*`, matching the design-doc identifier
 * "caliber:gw:evaluator".
 *
 * Legacy alias for `CALIBER_QUEUE_PREFIX` — kept so existing import names
 * (`EVALUATOR_QUEUE_PREFIX`) stay valid after the shared-prefix extraction.
 */
export const EVALUATOR_QUEUE_PREFIX = CALIBER_QUEUE_PREFIX;

/** BullMQ job name used for every evaluator job. */
export const EVALUATOR_JOB_NAME = "evaluator";

/**
 * Default retry / retention policy for evaluator jobs.
 * Legacy alias for `DEFAULT_JOB_OPTIONS`.
 */
export const EVALUATOR_DEFAULT_JOB_OPTIONS = DEFAULT_JOB_OPTIONS;

// ── Payload schema ───────────────────────────────────────────────────────────

const UUID = z.string().uuid();
const ISO_DATETIME = z.string().datetime();

/**
 * Job payload validated at enqueue time. Carries evaluation request metadata:
 * org and user scope, evaluation period (start/end as ISO strings), period
 * type (daily/weekly/monthly), and audit trail of who triggered it.
 *
 * PR3 adds optional per-key fields:
 *   - `apiKeyId`: when set, scopes the evaluation to a single api_key (per-key
 *     grain).  When absent, the per-person grain is used (byte-identical).
 *   - `keyNameSnapshot`: snapshot of `api_keys.name` at enqueue time.  Stored
 *     in `evaluation_reports_by_key.key_name_snapshot` so the report label
 *     survives future renames/revocations.  Required (non-empty) when
 *     `apiKeyId` is set; ignored otherwise.  Enforced via `.refine()` so
 *     the cron always supplies it and the worker never silently receives "".
 *
 * PR4 adds:
 *   - org-scoped v2 jobId derivation when `apiKeyId` is present (in `enqueueEvaluator`).
 *   - Zod `.refine()` co-presence: `apiKeyId` set → `keyNameSnapshot` required
 *     and non-empty.
 */
export const EvaluatorJobPayload = z
  .object({
    orgId: UUID,
    userId: UUID,
    periodStart: ISO_DATETIME,
    periodEnd: ISO_DATETIME,
    periodType: z.enum(["daily", "weekly", "monthly"]),
    triggeredBy: z.enum(["cron", "admin_rerun", "manual"]),
    triggeredByUser: UUID.nullable().default(null),
    /** Per-key grain (PR3): api_key UUID to evaluate. Absent → per-person. */
    apiKeyId: UUID.optional(),
    /** Per-key grain (PR3+PR4): snapshot of the key name at enqueue time.
     *  Required and non-empty when `apiKeyId` is set (enforced by refine). */
    keyNameSnapshot: z.string().optional(),
  })
  .refine(
    (d) =>
      d.apiKeyId === undefined ||
      (typeof d.keyNameSnapshot === "string" && d.keyNameSnapshot.length > 0),
    {
      message:
        "keyNameSnapshot must be a non-empty string when apiKeyId is set",
      path: ["keyNameSnapshot"],
    },
  );

export type EvaluatorJobPayload = z.infer<typeof EvaluatorJobPayload>;

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CreateEvaluatorQueueOptions {
  connection: QueueConnection;
  /** Override prefix (default `EVALUATOR_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/**
 * Build a real BullMQ Queue wired to `caliber:gw:evaluator:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueEvaluator`.
 */
export function createEvaluatorQueue(
  opts: CreateEvaluatorQueueOptions,
): Queue<EvaluatorJobPayload> {
  return new Queue<EvaluatorJobPayload>(
    EVALUATOR_QUEUE_NAME,
    buildQueueOptions(opts),
  );
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueEvaluatorResult {
  /**
   * The BullMQ job ID — produced by `buildEvaluatorJobId` (colon-free).
   *
   * - Per-person (apiKeyId absent): `eval_v2_person_${orgId}_${userId}_${periodStart}_${periodType}`
   *   with all `:` replaced by `-`.
   * - Per-key (apiKeyId present): `eval_v2_key_${orgId}_${userId}_${apiKeyId}_${periodStart}_${periodType}`
   *   with all `:` replaced by `-`.
   *
   * The two formats can never collide because the grain prefix differs, and
   * the same user/period in different orgs does not collide because `orgId`
   * is part of the identity.
   */
  jobId: string;
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is derived by `buildEvaluatorJobId` (from `@caliber/evaluator`), which
 *   produces a colon-free, underscore-joined id. BullMQ 5.x rejects custom ids
 *   that contain `:` unless they split into exactly 3 parts; ISO periodStart
 *   embeds multiple colons and would trigger that error with a naive template
 *   literal. The shared builder is also used by `apps/api reports.ts` rerun so
 *   cron and admin-rerun always produce the same id for the same inputs (dedup).
 * - Collision safety: per-person and per-key grains are prefixed separately,
 *   and orgId is part of the identity so cross-org jobs do not dedup each other.
 * - On Zod validation failure this throws — treat as a programmer error
 *   (the caller assembled a bad payload), not a transient condition.
 * - On Redis-side failure (`queue.add` rejects), the error propagates.
 *   Evaluator jobs are not best-effort like body capture; the caller should
 *   handle enqueue failures appropriately.
 */
export async function enqueueEvaluator(
  queue: QueueLike,
  payload: unknown,
): Promise<EnqueueEvaluatorResult> {
  const validated = EvaluatorJobPayload.parse(payload);
  const jobId = buildEvaluatorJobId(validated);

  await queue.add(EVALUATOR_JOB_NAME, validated, { jobId });

  return { jobId };
}
