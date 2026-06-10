export type Platform = "anthropic" | "openai";

/** One normalized model from a provider /v1/models list. `created` is epoch ms. */
export interface ModelCatalogEntry {
  id: string;
  created: number;
}

/** Cache/bucket identity — entitlement-aware (see model-alias spec). */
export interface BucketKey {
  platform: Platform;
  baseUrl: string;
  credentialType: "api_key" | "oauth";
}

export interface ResolveResult {
  /** The model id to send upstream (== requested when not an alias / unresolvable). */
  resolved: string;
  /** True only when an alias was matched and rewritten. */
  wasAlias: boolean;
  /** The family prefix matched (diagnostics / metrics label). */
  family?: string;
}

export function bucketKeyString(b: BucketKey): string {
  return `${b.platform}|${b.baseUrl}|${b.credentialType}`;
}
