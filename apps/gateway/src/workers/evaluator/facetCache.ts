/**
 * Concrete `getFacet` cache reader for the gateway evaluator worker
 * (Plan 4C Phase 2 Part 15).
 *
 * `ensureFacets` (from `@caliber/evaluator`) calls `getFacet(requestId)` once
 * per session before deciding whether to extract. This factory binds that
 * contract to a real Drizzle `Database`, returning the existing row's
 * `promptVersion` (or null when no row exists) so the caller can compare
 * against `CURRENT_PROMPT_VERSION`.
 */

import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { requestBodyFacets } from "@caliber/db";

export function createFacetCacheReader(
  db: Database,
): (requestId: string) => Promise<{ promptVersion: number } | null> {
  return async (requestId) => {
    const rows = await db
      .select({ promptVersion: requestBodyFacets.promptVersion })
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId))
      .limit(1);
    return rows[0] ?? null;
  };
}
