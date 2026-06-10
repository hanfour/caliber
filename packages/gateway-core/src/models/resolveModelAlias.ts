import type { ModelCatalogEntry, Platform, ResolveResult } from "./types.js";

const passthrough = (m: string): ResolveResult => ({ resolved: m, wasAlias: false });

export function resolveModelAlias(
  requested: string,
  platform: Platform,
  catalog: ModelCatalogEntry[],
): ResolveResult {
  // Exact concrete id → never touch.
  if (catalog.some((e) => e.id === requested)) return passthrough(requested);

  // Alias form → family prefix.
  const family = requested.endsWith("-latest")
    ? requested.slice(0, -"-latest".length)
    : requested;

  const members = familyMembers(requested, family, platform, catalog);
  if (members.length === 0) return passthrough(requested);

  const newest = pickNewest(members);
  return { resolved: newest.id, wasAlias: true, family };
}

function pickNewest(members: ModelCatalogEntry[]): ModelCatalogEntry {
  return members.reduce((best, e) =>
    e.created > best.created || (e.created === best.created && e.id > best.id) ? e : best,
  );
}

function familyMembers(
  _requested: string,
  family: string,
  platform: Platform,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  if (platform === "anthropic") {
    const prefix = `${family}-`;
    return catalog.filter((e) => e.id.startsWith(prefix));
  }
  // openai handled in a later task (conservative). Default: no match for now.
  return openaiFamilyMembers(family, catalog);
}

// Placeholder until the OpenAI task — keep export stable.
function openaiFamilyMembers(_family: string, _catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [];
}
