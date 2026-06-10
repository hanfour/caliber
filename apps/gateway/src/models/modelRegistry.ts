import {
  bucketKeyString,
  type BucketKey,
  type ModelCatalogEntry,
} from "@caliber/gateway-core/models";
import { staticFallbackCatalog } from "./staticFallback.js";

interface Deps {
  env: Record<string, string | undefined>;
  fallbackMetric: (platform: string, credentialType: string) => void;
}

export interface RefreshDeps {
  discoverBuckets: () => Promise<BucketKey[]>;
  fetchForBucket: (b: BucketKey) => Promise<ModelCatalogEntry[]>;
}

export class ModelRegistry {
  private cache = new Map<string, ModelCatalogEntry[]>();
  constructor(private deps: Deps) {}

  get(bucket: BucketKey): ModelCatalogEntry[] {
    const hit = this.cache.get(bucketKeyString(bucket));
    if (hit && hit.length > 0) return hit;
    this.deps.fallbackMetric(bucket.platform, bucket.credentialType);
    return staticFallbackCatalog(bucket.platform, this.deps.env);
  }

  set(bucket: BucketKey, catalog: ModelCatalogEntry[]): void {
    this.cache.set(bucketKeyString(bucket), catalog);
  }

  buckets(): string[] {
    return [...this.cache.keys()];
  }

  async refreshOnce(deps: RefreshDeps): Promise<void> {
    const buckets = await deps.discoverBuckets();
    for (const b of buckets) {
      try {
        const cat = await deps.fetchForBucket(b);
        if (cat.length > 0) this.set(b, cat); // empty → leave on fallback
      } catch {
        // swallow — never let refresh break the gateway
      }
    }
  }
}
