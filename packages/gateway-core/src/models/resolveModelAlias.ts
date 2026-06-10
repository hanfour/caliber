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

const OPENAI_SUBMODEL_WORDS = ["mini", "nano", "micro", "turbo", "preview"];

function openaiFamilyMembers(family: string, catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const prefix = `${family}-`;
  return catalog.filter((e) => {
    if (!e.id.startsWith(prefix)) return false;
    // The segment immediately after the family prefix must NOT be:
    // 1. Another sub-model keyword (mini/nano/…) — otherwise gpt-5 would swallow gpt-5-mini
    // 2. Another family component (must look like a version/date, not a model number)
    const rest = e.id.slice(prefix.length);
    const nextWord = rest.split("-")[0] ?? "";
    if (OPENAI_SUBMODEL_WORDS.includes(nextWord)) return false;
    // Must have 4+ consecutive digits (year-like) or full version pattern (e.g., v4-turbo)
    // to distinguish from family components like "5" in gpt-5
    return /^\d{4}/.test(nextWord);
  });
}
