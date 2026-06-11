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
    return anthropicFamilyMembers(family, catalog);
  }
  // openai handled in a later task (conservative). Default: no match for now.
  return openaiFamilyMembers(family, catalog);
}

function anthropicFamilyMembers(
  family: string,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const prefix = `${family}-`;
  return catalog.filter((e) => {
    if (!e.id.startsWith(prefix)) return false;
    // The family must extend up to the version: the segment immediately after
    // `${family}-` must begin a version number (a digit), not another name word.
    // Keeps `claude-haiku` → `claude-haiku-4-5-…` while a bare brand like
    // `claude` (next segment "haiku") or `claude-latest` passes through instead
    // of silently collapsing across every Claude family.
    const nextSeg = e.id.slice(prefix.length).split("-")[0] ?? "";
    return /^\d/.test(nextSeg);
  });
}

const OPENAI_SUBMODEL_WORDS = ["mini", "nano", "micro", "turbo", "preview"];

function openaiFamilyMembers(family: string, catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((e) => {
    if (!e.id.startsWith(family)) return false;
    // The family must be followed immediately by a version separator, so
    // family "gpt-5" does NOT swallow a different family like "gpt-50.1".
    const sep = e.id[family.length];
    if (sep !== "-" && sep !== ".") return false;
    const rest = e.id.slice(family.length + 1);
    if (rest.length === 0) return false;
    const segments = rest.split(/[-.]/);
    // Exclude sub-model variants anywhere in the suffix (gpt-5-mini, gpt-5.4-mini).
    if (segments.some((s) => OPENAI_SUBMODEL_WORDS.includes(s))) return false;
    const first = segments[0] ?? "";
    // Dotted version (gpt-5.4 → "4"): pure-numeric version segment.
    // Dated/hyphenated (gpt-5-2025-09-01 → "2025"): conservative 4-digit year prefix.
    return sep === "." ? /^\d+$/.test(first) : /^\d{4}/.test(first);
  });
}
