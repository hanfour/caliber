/**
 * Rubric resolver (Plan 4B Part 4, Task 4.4).
 *
 * Given `{ orgId, apiKeyId?, locale? }`, returns the rubric to use for evaluation:
 * 0. If apiKeyId set → load key-scoped rubric (api_key_id = apiKeyId AND org_id = orgId)
 * 1. If org has `rubric_id` set → load that rubric (must have api_key_id IS NULL)
 * 2. Else → load platform-default rubric matching locale (or `en` fallback)
 * 3. Cache results in-memory for 5 minutes to avoid hitting DB per job
 *
 * Soft-deleted rubrics are excluded at every step. If a branch misses, the next
 * branch is tried. Per-person callers (no apiKeyId) are byte-identical to before:
 * branch 0 is skipped and the result shape (incl. fromOrgCustom) is unchanged.
 *
 * Cache key: `${orgId}::${apiKeyId ?? ""}::${locale}` — per-key and per-person
 * entries never collide. invalidate(orgId) still prefix-matches `${orgId}::`.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations, rubrics } from "@caliber/db";
import { rubricSchema, type Rubric } from "@caliber/evaluator";

export const RUBRIC_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ResolveRubricInput {
  db: Database;
  orgId: string;
  apiKeyId?: string;
  locale?: "en" | "zh-Hant" | "ja";
}

export interface ResolvedRubric {
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  fromOrgCustom: boolean; // true if using org's custom rubric, false for platform-default or key
  source: "key" | "org" | "platform";
}

export interface RubricResolver {
  resolve: (input: ResolveRubricInput) => Promise<ResolvedRubric>;
  invalidate: (orgId?: string) => void;
  clear: () => void;
}

interface CacheEntry {
  value: ResolvedRubric;
  expiresAtMs: number;
}

/**
 * Create a rubric resolver with in-memory caching.
 * Caches keyed by `orgId::apiKeyId::locale` with 5-minute TTL by default.
 * Per-person callers (no apiKeyId) use `orgId::::locale`.
 */
export function createRubricResolver(opts?: {
  now?: () => number;
  ttlMs?: number;
}): RubricResolver {
  const cache = new Map<string, CacheEntry>();
  const now = opts?.now ?? (() => Date.now());
  const ttl = opts?.ttlMs ?? RUBRIC_CACHE_TTL_MS;

  function cacheKey(
    orgId: string,
    apiKeyId: string | undefined,
    locale: string,
  ): string {
    return `${orgId}::${apiKeyId ?? ""}::${locale}`;
  }

  async function resolve(input: ResolveRubricInput): Promise<ResolvedRubric> {
    const locale = input.locale ?? "en";
    const key = cacheKey(input.orgId, input.apiKeyId, locale);

    const hit = cache.get(key);
    if (hit && hit.expiresAtMs > now()) {
      return hit.value;
    }

    const resolved = await doResolve(
      input.db,
      input.orgId,
      input.apiKeyId,
      locale,
    );
    cache.set(key, { value: resolved, expiresAtMs: now() + ttl });
    return resolved;
  }

  function invalidate(orgId?: string): void {
    if (orgId === undefined) {
      cache.clear();
      return;
    }
    for (const key of cache.keys()) {
      if (key.startsWith(`${orgId}::`)) cache.delete(key);
    }
  }

  function clear(): void {
    cache.clear();
  }

  return { resolve, invalidate, clear };
}

/**
 * Core resolution logic: key-scoped → org custom → platform-default.
 *
 * Per-person path (apiKeyId=undefined): branch 0 is skipped → identical to
 * the pre-PR2 code path (DB queries and returned shape unchanged).
 */
async function doResolve(
  db: Database,
  orgId: string,
  apiKeyId: string | undefined,
  locale: string,
): Promise<ResolvedRubric> {
  // 0. Key-scoped lookup (skipped when apiKeyId is absent → per-person byte-identity)
  if (apiKeyId !== undefined) {
    const keyRubric = await db
      .select()
      .from(rubrics)
      .where(
        and(
          eq(rubrics.apiKeyId, apiKeyId),
          eq(rubrics.orgId, orgId),
          isNull(rubrics.deletedAt),
        ),
      )
      .limit(1)
      .then((r) => r[0]);

    if (keyRubric) {
      const parsed = rubricSchema.parse(keyRubric.definition);
      return {
        rubric: parsed,
        rubricId: keyRubric.id,
        rubricVersion: keyRubric.version,
        fromOrgCustom: false,
        source: "key",
      };
    }
    // Miss → fall through to org branch
  }

  // 1. Check if org has custom rubric configured (api_key_id IS NULL guard is
  //    required: two writers exist for organizations.rubric_id and the resolver
  //    filter is the backstop that prevents a key rubric being scored org-wide)
  const org = await db
    .select({ rubricId: organizations.rubricId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .then((r) => r[0]);

  if (org?.rubricId) {
    const custom = await db
      .select()
      .from(rubrics)
      .where(
        and(
          eq(rubrics.id, org.rubricId),
          isNull(rubrics.deletedAt),
          isNull(rubrics.apiKeyId),
          or(isNull(rubrics.orgId), eq(rubrics.orgId, orgId)),
        ),
      )
      .limit(1)
      .then((r) => r[0]);

    if (custom) {
      const parsed = rubricSchema.parse(custom.definition);
      return {
        rubric: parsed,
        rubricId: custom.id,
        rubricVersion: custom.version,
        fromOrgCustom: true,
        source: "org",
      };
    }
    // Org's configured rubric missing, soft-deleted, or key-scoped — fall through
  }

  // 2. Platform-default for locale (org_id IS NULL, is_default = true, api_key_id IS NULL)
  const candidates = await db
    .select()
    .from(rubrics)
    .where(
      and(
        isNull(rubrics.orgId),
        eq(rubrics.isDefault, true),
        isNull(rubrics.deletedAt),
        isNull(rubrics.apiKeyId),
      ),
    );

  // Pick the one matching locale, else fall back to "en"
  const byLocale = candidates.find((r) => {
    try {
      const def = rubricSchema.parse(r.definition);
      return def.locale === locale;
    } catch {
      return false;
    }
  });

  const enFallback = candidates.find((r) => {
    try {
      const def = rubricSchema.parse(r.definition);
      return def.locale === "en";
    } catch {
      return false;
    }
  });

  const chosen = byLocale ?? enFallback ?? candidates[0];
  if (!chosen) {
    throw new Error(`No platform-default rubric found (locale=${locale})`);
  }

  const parsed = rubricSchema.parse(chosen.definition);
  return {
    rubric: parsed,
    rubricId: chosen.id,
    rubricVersion: chosen.version,
    fromOrgCustom: false,
    source: "platform",
  };
}
