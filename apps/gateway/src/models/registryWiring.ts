import { and, eq, isNull } from "drizzle-orm";
import { upstreamAccounts, type Database } from "@caliber/db";
import type { BucketKey, ModelCatalogEntry, Platform } from "@caliber/gateway-core/models";
import {
  resolveCredential,
  type ResolvedCredential,
} from "../runtime/resolveCredential.js";
import { fetchModelCatalog } from "./modelCatalogFetch.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** Resolve the upstream base URL for a platform from env. */
export function baseUrlFor(
  platform: Platform,
  env: { UPSTREAM_ANTHROPIC_BASE_URL?: string; UPSTREAM_OPENAI_BASE_URL?: string },
): string {
  if (platform === "anthropic") {
    return env.UPSTREAM_ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  }
  // openai (sub2api) — no static default; empty means "not configured".
  return env.UPSTREAM_OPENAI_BASE_URL || "";
}

/**
 * Build the `/v1/models` auth headers for the (platform, credential-class)
 * combination. Spike-confirmed 2026-06-10 — see task spec.
 */
export function authHeadersFor(
  platform: Platform,
  cred: ResolvedCredential,
): Record<string, string> {
  if (platform === "anthropic") {
    if (cred.type === "oauth") {
      return {
        authorization: `Bearer ${cred.accessToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": "oauth-2025-04-20",
      };
    }
    return {
      "x-api-key": cred.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }
  // openai (sub2api) — bearer token from either credential class.
  const token = cred.type === "api_key" ? cred.apiKey : cred.accessToken;
  return { authorization: `Bearer ${token}` };
}

/**
 * DISTINCT in-use buckets over active, non-deleted upstreams. Buckets whose
 * platform/type are unrecognised, or whose base URL is unconfigured (openai
 * with no UPSTREAM_OPENAI_BASE_URL), are skipped.
 */
export async function discoverBuckets(
  db: Database,
  env: { UPSTREAM_ANTHROPIC_BASE_URL?: string; UPSTREAM_OPENAI_BASE_URL?: string },
): Promise<BucketKey[]> {
  const rows = await db
    .selectDistinct({
      platform: upstreamAccounts.platform,
      type: upstreamAccounts.type,
    })
    .from(upstreamAccounts)
    .where(
      and(isNull(upstreamAccounts.deletedAt), eq(upstreamAccounts.status, "active")),
    );
  const out: BucketKey[] = [];
  for (const r of rows) {
    if (r.platform !== "anthropic" && r.platform !== "openai") continue;
    if (r.type !== "api_key" && r.type !== "oauth") continue;
    const baseUrl = baseUrlFor(r.platform, env);
    if (!baseUrl) continue; // openai with no base url configured → skip
    out.push({ platform: r.platform, baseUrl, credentialType: r.type });
  }
  return out;
}

/** Pick one active account id for a bucket's (platform, type). */
async function pickAccountId(db: Database, bucket: BucketKey): Promise<string | null> {
  const [row] = await db
    .select({ id: upstreamAccounts.id })
    .from(upstreamAccounts)
    .where(
      and(
        eq(upstreamAccounts.platform, bucket.platform),
        eq(upstreamAccounts.type, bucket.credentialType),
        isNull(upstreamAccounts.deletedAt),
        eq(upstreamAccounts.status, "active"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Build the `RefreshDeps` the ModelRegistry consumes: per-bucket discovery +
 * a fetch that vault-decrypts a credential OF THAT BUCKET'S TYPE and calls the
 * upstream `/v1/models`. Every failure path is metric'd and degrades to `[]`
 * (the registry then leaves the bucket on its static fallback).
 */
export function buildRefreshDeps(opts: {
  db: Database;
  env: {
    UPSTREAM_ANTHROPIC_BASE_URL?: string;
    UPSTREAM_OPENAI_BASE_URL?: string;
    CREDENTIAL_ENCRYPTION_KEY?: string;
  };
  fetchMetric: (
    platform: string,
    bucketType: string,
    result: "ok" | "empty" | "error",
  ) => void;
  fetchImpl?: typeof fetch;
  /**
   * Credential decryption seam. Defaults to the real `resolveCredential`;
   * tests inject a stub to exercise the credential-type guard below without
   * a live vault row.
   */
  resolveCredentialImpl?: (
    db: Database,
    accountId: string,
    o: { masterKeyHex: string },
  ) => Promise<ResolvedCredential>;
  /**
   * Optional structured logger for the credential-mismatch skip path so ops
   * can spot stale `upstream_accounts.type` rows. Defaults to a no-op.
   */
  logger?: { warn: (obj: unknown, msg: string) => void };
}) {
  const resolveCred = opts.resolveCredentialImpl ?? resolveCredential;
  return {
    discoverBuckets: () => discoverBuckets(opts.db, opts.env),
    fetchForBucket: async (b: BucketKey): Promise<ModelCatalogEntry[]> => {
      try {
        const accountId = await pickAccountId(opts.db, b);
        if (!accountId) {
          opts.fetchMetric(b.platform, b.credentialType, "error");
          return [];
        }
        const cred = await resolveCred(opts.db, accountId, {
          masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
        });
        // Finding 3: `pickAccountId` selects by the ROW's
        // `upstream_accounts.type`, but that hint can be stale. If the
        // DECRYPTED credential's class disagrees with the bucket type, fetching
        // would key a catalog under an entitlement the credential doesn't
        // actually have (poisoning the bucket). Skip the fetch, emit "error",
        // and degrade to the static fallback rather than trust the stale row.
        if (cred.type !== b.credentialType) {
          opts.logger?.warn(
            {
              platform: b.platform,
              accountId,
              bucketType: b.credentialType,
              credentialType: cred.type,
            },
            "model-registry refresh: stale upstream_accounts.type — decrypted credential class ≠ bucket type; skipping fetch (bucket stays on static fallback)",
          );
          opts.fetchMetric(b.platform, b.credentialType, "error");
          return [];
        }
        const headers = authHeadersFor(b.platform, cred);
        const cat = await fetchModelCatalog(b.platform, b.baseUrl, {
          authHeaders: headers,
          fetchImpl: opts.fetchImpl,
        });
        opts.fetchMetric(b.platform, b.credentialType, cat.length > 0 ? "ok" : "empty");
        return cat;
      } catch {
        opts.fetchMetric(b.platform, b.credentialType, "error");
        return [];
      }
    },
  };
}
