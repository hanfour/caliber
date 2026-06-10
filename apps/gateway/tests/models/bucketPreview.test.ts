import { describe, it, expect } from "vitest";
import { previewBuckets } from "../../src/models/bucketPreview.js";

describe("previewBuckets", () => {
  it("returns a single bucket when all candidate rows share a type", async () => {
    const set = await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => ["oauth", "oauth"] });
    expect(set).toHaveLength(1);
    expect(set[0]).toEqual({ platform: "anthropic", baseUrl: "u", credentialType: "oauth" });
  });
  it("returns multiple buckets when types differ", async () => {
    const set = await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => ["oauth", "api_key"] });
    expect(set.map((b) => b.credentialType).sort()).toEqual(["api_key", "oauth"]);
  });
  it("returns [] when there are no candidates", async () => {
    expect(await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => [] })).toEqual([]);
  });
});
