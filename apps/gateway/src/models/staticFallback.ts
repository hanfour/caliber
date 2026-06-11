import type { ModelCatalogEntry, Platform } from "@caliber/gateway-core/models";

// Conservative known-newest per family. Live fetch overrides these whenever
// available; this only guards cold-start / fetch-failure. Keep ids current.
const DEFAULTS: Record<Platform, string[]> = {
  anthropic: [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1-20250805",
  ],
  openai: [
    "gpt-5.4-mini",
    "gpt-5.4",
  ],
};

const SENTINEL_CREATED = 1; // any real created timestamp out-ranks fallback

export function staticFallbackCatalog(
  platform: Platform,
  env: Record<string, string | undefined>,
): ModelCatalogEntry[] {
  const key = `GATEWAY_MODEL_REGISTRY_FALLBACK_${platform.toUpperCase()}`;
  const override = (env[key] ?? "").split(/[,\s]+/).filter(Boolean);
  const ids = override.length > 0 ? override : DEFAULTS[platform];
  return ids.map((id) => ({ id, created: SENTINEL_CREATED }));
}
