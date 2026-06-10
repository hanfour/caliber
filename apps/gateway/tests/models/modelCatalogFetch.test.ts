import { describe, it, expect } from "vitest";
import { fetchModelCatalog } from "../../src/models/modelCatalogFetch.js";

const fakeFetch = (status: number, body: unknown) =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;

describe("fetchModelCatalog", () => {
  it("normalizes Anthropic data[] with created_at ISO → epoch ms", async () => {
    const f = fakeFetch(200, { data: [{ id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" }] });
    const cat = await fetchModelCatalog("anthropic", "https://api.anthropic.com", { authHeaders: {}, fetchImpl: f });
    expect(cat).toEqual([{ id: "claude-haiku-4-5-20251001", created: Date.parse("2025-10-01T00:00:00Z") }]);
  });
  it("normalizes OpenAI (sub2api) data[] with created_at ISO → epoch ms", async () => {
    const f = fakeFetch(200, { data: [{ id: "gpt-5.4", created_at: "2025-01-01T00:00:00Z" }] });
    const cat = await fetchModelCatalog("openai", "https://sub2api", { authHeaders: {}, fetchImpl: f });
    expect(cat).toEqual([{ id: "gpt-5.4", created: Date.parse("2025-01-01T00:00:00Z") }]);
  });
  it("returns [] on non-2xx (caller falls back)", async () => {
    const cat = await fetchModelCatalog("anthropic", "https://x", { authHeaders: {}, fetchImpl: fakeFetch(404, {}) });
    expect(cat).toEqual([]);
  });
  it("returns [] on missing/garbage data", async () => {
    const cat = await fetchModelCatalog("anthropic", "https://x", { authHeaders: {}, fetchImpl: fakeFetch(200, { nope: 1 }) });
    expect(cat).toEqual([]);
  });
});
