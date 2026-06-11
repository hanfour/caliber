import {
  bucketKeyString,
  type BucketKey,
  type ModelCatalogEntry,
} from "@caliber/gateway-core/models";
import { staticFallbackCatalog } from "./staticFallback.js";

// Default per-bucket cache TTL. Concrete and generous (2h) so that
// `set()`-then-`get()` callers/tests running in milliseconds stay fresh. The
// gateway overrides this with a value derived from the refresh cadence.
const DEFAULT_TTL_MS = 2 * 3600 * 1000;

interface Deps {
  env: Record<string, string | undefined>;
  fallbackMetric: (platform: string, credentialType: string) => void;
  // Optional structured logger — used to surface (never swallow) a bucket
  // discovery failure inside refreshOnce. Optional so existing constructions
  // compile unchanged.
  logger?: { warn: (obj: unknown, msg: string) => void };
  // Injectable clock for TTL testability. Defaults to Date.now (allowed here —
  // this registry lives in apps/gateway, not gateway-core).
  now?: () => number;
  // Per-bucket cache TTL in ms. Defaults to DEFAULT_TTL_MS.
  ttlMs?: number;
}

export interface RefreshDeps {
  discoverBuckets: () => Promise<BucketKey[]>;
  fetchForBucket: (b: BucketKey) => Promise<ModelCatalogEntry[]>;
}

interface CacheEntry {
  catalog: ModelCatalogEntry[];
  fetchedAt: number;
}

export class ModelRegistry {
  private cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private deps: Deps) {
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(bucket: BucketKey): ModelCatalogEntry[] {
    const hit = this.cache.get(bucketKeyString(bucket));
    // Serve the cached catalog ONLY when it exists, is non-empty, AND is fresh.
    // A stale (TTL-expired) or empty entry degrades to the static fallback so a
    // bad/empty refresh can never serve stale ids forever (bounded
    // stale-while-revalidate).
    if (hit && hit.catalog.length > 0 && this.now() - hit.fetchedAt < this.ttlMs) {
      return hit.catalog;
    }
    this.deps.fallbackMetric(bucket.platform, bucket.credentialType);
    return staticFallbackCatalog(bucket.platform, this.deps.env);
  }

  set(bucket: BucketKey, catalog: ModelCatalogEntry[]): void {
    this.cache.set(bucketKeyString(bucket), {
      catalog,
      fetchedAt: this.now(),
    });
  }

  buckets(): string[] {
    return [...this.cache.keys()];
  }

  async refreshOnce(deps: RefreshDeps): Promise<void> {
    // Bucket discovery is the one await outside the per-bucket try/catch — guard
    // it so a transient discovery failure (e.g. DB down) is logged and skips the
    // cycle rather than rejecting into the fire-and-forget callers (boot +
    // setInterval) as an unhandled rejection. refreshOnce NEVER rejects.
    let buckets: BucketKey[];
    try {
      buckets = await deps.discoverBuckets();
    } catch (err) {
      this.deps.logger?.warn(
        { err: err instanceof Error ? { name: err.name, message: err.message } : err },
        "model registry: bucket discovery failed; skipping refresh cycle",
      );
      return;
    }
    for (const b of buckets) {
      try {
        const cat = await deps.fetchForBucket(b);
        if (cat.length > 0) this.set(b, cat); // empty → leave on cache; TTL expires it
      } catch {
        // swallow — never let a single bucket's refresh break the gateway
      }
    }
  }
}
