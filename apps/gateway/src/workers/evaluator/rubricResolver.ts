/**
 * Rubric resolver (Plan 4B Part 4, Task 4.4).
 *
 * Given `{ orgId, locale? }`, returns the rubric to use for evaluation:
 * 1. If org has `rubric_id` set → load that rubric from `rubrics` table
 * 2. Else → load platform-default rubric matching locale (or `en` fallback)
 * 3. Cache results in-memory for 5 minutes to avoid hitting DB per job
 *
 * Soft-deleted rubrics are excluded. If org's configured rubric is soft-deleted,
 * we fall through to platform-default.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations, rubrics } from "@caliber/db";
import { rubricSchema, type Rubric } from "@caliber/evaluator";

export const RUBRIC_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ResolveRubricInput {
  db: Database;
  orgId: string;
  locale?: "en" | "zh-Hant" | "ja";
}

export interface ResolvedRubric {
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  fromOrgCustom: boolean; // true if using org's custom rubric, false for platform-default
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
 * Caches keyed by `orgId::locale` with 5-minute TTL by default.
 */
export function createRubricResolver(opts?: {
  now?: () => number;
  ttlMs?: number;
}): RubricResolver {
  const cache = new Map<string, CacheEntry>();
  const now = opts?.now ?? (() => Date.now());
  const ttl = opts?.ttlMs ?? RUBRIC_CACHE_TTL_MS;

  function cacheKey(orgId: string, locale: string): string {
    return `${orgId}::${locale}`;
  }

  async function resolve(input: ResolveRubricInput): Promise<ResolvedRubric> {
    const locale = input.locale ?? "en";
    const key = cacheKey(input.orgId, locale);

    const hit = cache.get(key);
    if (hit && hit.expiresAtMs > now()) {
      return hit.value;
    }

    const resolved = await doResolve(input.db, input.orgId, locale);
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
 * Core resolution logic: fetch org custom rubric or fall back to platform-default.
 */
async function doResolve(
  db: Database,
  orgId: string,
  locale: string,
): Promise<ResolvedRubric> {
  // 1. Check if org has custom rubric configured
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
      .where(and(eq(rubrics.id, org.rubricId), isNull(rubrics.deletedAt)))
      .limit(1)
      .then((r) => r[0]);

    if (custom) {
      const parsed = rubricSchema.parse(custom.definition);
      return {
        rubric: parsed,
        rubricId: custom.id,
        rubricVersion: custom.version,
        fromOrgCustom: true,
      };
    }
    // Org's configured rubric missing or soft-deleted — fall through to default
  }

  // 2. Platform-default for locale (org_id IS NULL, is_default = true)
  const candidates = await db
    .select()
    .from(rubrics)
    .where(
      and(
        isNull(rubrics.orgId),
        eq(rubrics.isDefault, true),
        isNull(rubrics.deletedAt),
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
  };
}
