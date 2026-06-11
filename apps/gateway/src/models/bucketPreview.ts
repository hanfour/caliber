import type { BucketKey, Platform } from "@caliber/gateway-core/models";

export interface PreviewInput {
  platform: Platform;
  baseUrl: string;
  /** Read-only listing of the row-level credential types of candidate accounts. */
  listCandidateTypes: () => Promise<Array<"api_key" | "oauth">>;
}

export async function previewBuckets(input: PreviewInput): Promise<BucketKey[]> {
  const types = new Set(await input.listCandidateTypes());
  return [...types].map((credentialType) => ({
    platform: input.platform,
    baseUrl: input.baseUrl,
    credentialType,
  }));
}
