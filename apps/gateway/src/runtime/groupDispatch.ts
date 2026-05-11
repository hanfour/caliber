// Group context resolution for Plan 5A Part 8.
//
// Maps an authenticated API key onto the AccountGroup that scopes its
// scheduling. Two shapes:
//
//   1. Real group: api_keys.group_id is set → look up the row, surface
//      its platform / rate multiplier / exclusivity flag.
//   2. Legacy: api_keys.group_id is NULL → synthesise a virtual
//      "legacy:<orgId>" group on platform "anthropic". Preserves 4A
//      behaviour for keys issued before migration 0008. The synthetic
//      groupId is opaque — the scheduler ignores it (no DB join, since
//      no row exists) and falls through to org/team-scoped Layer 3.
//
// `resolveGroupContext` returns null when the api key references a
// group that has been disabled or deleted; the middleware translates
// that into 403 group_not_found_or_disabled so callers don't get a
// confusing "no upstreams" later.

import { and, eq, isNull } from "drizzle-orm";
import { accountGroups } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { Platform } from "@caliber/gateway-core";

// Mirror of the Platform union from `@caliber/gateway-core` for runtime
// validation. The `satisfies` ensures the literal stays in sync if the
// type ever expands.
const KNOWN_PLATFORMS = [
  "anthropic",
  "openai",
  "gemini",
  "antigravity",
] as const satisfies readonly Platform[];

function isPlatform(value: string): value is Platform {
  return (KNOWN_PLATFORMS as readonly string[]).includes(value);
}

/**
 * `account_groups.rate_multiplier` is a `decimal(10,4)` so drizzle
 * surfaces it as a string. Defensive parse: any non-finite or non-
 * positive value falls back to 1.0 so a bad row can't poison
 * scheduler weighted-score math with NaN.
 */
function parseRateMultiplier(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

export interface GroupContext {
  /** Either an AccountGroups row id, or `legacy:<orgId>` for null group keys. */
  groupId: string;
  platform: Platform;
  rateMultiplier: number;
  isExclusive: boolean;
  /** True when this is the synthetic legacy group, not a real DB row. */
  isLegacy: boolean;
}

export interface GroupResolveInput {
  orgId: string;
  groupId: string | null;
}

export async function resolveGroupContext(
  db: Database,
  apiKey: GroupResolveInput,
): Promise<GroupContext | null> {
  if (!apiKey.groupId) {
    return {
      groupId: `legacy:${apiKey.orgId}`,
      platform: "anthropic",
      rateMultiplier: 1.0,
      isExclusive: false,
      isLegacy: true,
    };
  }
  const row = await db
    .select({
      id: accountGroups.id,
      platform: accountGroups.platform,
      rateMultiplier: accountGroups.rateMultiplier,
      isExclusive: accountGroups.isExclusive,
    })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.id, apiKey.groupId),
        eq(accountGroups.orgId, apiKey.orgId),
        eq(accountGroups.status, "active"),
        isNull(accountGroups.deletedAt),
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!row) return null;
  // Reject rows whose `platform` doesn't match a known value — the
  // column has no CHECK constraint, so a stray value would otherwise
  // silently steer dispatch into a not-supported route.
  if (!isPlatform(row.platform)) return null;
  return {
    groupId: row.id,
    platform: row.platform,
    rateMultiplier: parseRateMultiplier(row.rateMultiplier),
    isExclusive: row.isExclusive,
    isLegacy: false,
  };
}

/**
 * `legacy:<orgId>` groupIds are synthetic — the scheduler shouldn't try
 * to JOIN against `account_group_members`. Routes that pass groupId to
 * `scheduler.select()` use this to decide whether to set `groupId` (real
 * group → sticky layers active) or leave it undefined (legacy → Layer 3
 * org/team selection).
 */
export function isLegacyGroupId(groupId: string): boolean {
  return groupId.startsWith("legacy:");
}
