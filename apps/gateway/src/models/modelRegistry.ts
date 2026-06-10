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
}
