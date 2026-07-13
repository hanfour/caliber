/**
 * Concrete `insertFacet` writer for the gateway evaluator worker
 * (Plan 4C Phase 2 Part 15).
 *
 * `extractOne` (from `@caliber/evaluator`) calls `insertFacet(row)` after each
 * facet extraction (success or deterministic failure). This factory binds
 * that contract to a real Drizzle `Database`, persisting each call into
 * `request_body_facets`.
 *
 * Uses ON CONFLICT (request_id) DO UPDATE so re-runs at a different
 * prompt_version overwrite the previous row cleanly. Same-prompt-version
 * re-runs should be filtered out by `ensureFacets` cache before reaching
 * here, so we won't normally pay the upsert cost.
 *
 * Invariants:
 *   - The returned writer is a pure closure over `db`. Callers must not
 *     mutate it.
 *   - `extractedAt` is set explicitly to `new Date()` on conflict so that
 *     the timestamp reflects the most recent extraction (the column
 *     defaults to `now()` on insert but Drizzle won't auto-update on
 *     conflict).
 */

import type { Database } from "@caliber/db";
import { requestBodyFacets } from "@caliber/db";
import type { FacetRow } from "@caliber/evaluator";

export function createFacetWriter(
  db: Database,
): (row: FacetRow) => Promise<void> {
  return async (row) => {
    await db
      .insert(requestBodyFacets)
      .values({
        requestId: row.requestId,
        orgId: row.orgId,
        sessionType: row.sessionType,
        outcome: row.outcome,
        claudeHelpfulness: row.claudeHelpfulness,
        frictionCount: row.frictionCount,
        bugsCaughtCount: row.bugsCaughtCount,
        codexErrorsCount: row.codexErrorsCount,
        userSatisfaction: row.userSatisfaction,
        extractedWithModel: row.extractedWithModel,
        promptVersion: row.promptVersion,
        extractionError: row.extractionError,
      })
      .onConflictDoUpdate({
        target: requestBodyFacets.requestId,
        set: {
          sessionType: row.sessionType,
          outcome: row.outcome,
          claudeHelpfulness: row.claudeHelpfulness,
          frictionCount: row.frictionCount,
          bugsCaughtCount: row.bugsCaughtCount,
          codexErrorsCount: row.codexErrorsCount,
          userSatisfaction: row.userSatisfaction,
          extractedWithModel: row.extractedWithModel,
          promptVersion: row.promptVersion,
          extractionError: row.extractionError,
          extractedAt: new Date(),
        },
      });
  };
}
