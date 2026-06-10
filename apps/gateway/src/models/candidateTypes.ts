import type { Database } from "@caliber/db";
import {
  listSchedulableCandidates,
  type ScheduleRequest,
} from "../runtime/scheduler.js";

/** Credential types an upstream account can carry. */
export type CredentialType = "api_key" | "oauth";

const CREDENTIAL_TYPES: ReadonlySet<string> = new Set<CredentialType>([
  "api_key",
  "oauth",
]);

/**
 * Read-only listing of the DISTINCT credential `type`s of the upstream
 * accounts that COULD serve the given request scope.
 *
 * Reuses the scheduler's `listSchedulableCandidates` candidate query verbatim
 * — so it inherits the SAME routingPolicy / userId / platform / group /
 * schedulable filtering the real scheduler uses — and projects each candidate
 * down to its `type`, deduped. It is side-effect-free: no sticky writes, no
 * scheduler decision metrics, just the candidate read.
 *
 * Feeds `previewBuckets` (models/bucketPreview.ts), whose `listCandidateTypes`
 * callback expects `() => Promise<Array<"api_key" | "oauth">>`.
 */
export async function listCandidateTypes(
  db: Database,
  req: ScheduleRequest,
): Promise<CredentialType[]> {
  const candidates = await listSchedulableCandidates(
    db,
    req,
    req.excludedAccountIds ?? new Set<string>(),
  );

  const types = new Set<CredentialType>();
  for (const candidate of candidates) {
    if (CREDENTIAL_TYPES.has(candidate.type)) {
      types.add(candidate.type as CredentialType);
    }
  }
  return [...types];
}
