import type { ModelCatalogEntry, Platform } from "@caliber/gateway-core/models";

interface FetchOpts {
  authHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchModelCatalog(
  _platform: Platform,
  baseUrl: string,
  opts: FetchOpts,
): Promise<ModelCatalogEntry[]> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      method: "GET",
      headers: opts.authHeaders,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const raw of data) {
    const r = raw as { id?: unknown; created?: unknown; created_at?: unknown };
    if (typeof r.id !== "string") continue;
    // SPIKE 2026-06-10: both anthropic AND sub2api return created_at ISO.
    let created: number | null = null;
    if (typeof r.created_at === "string") {
      const ms = Date.parse(r.created_at);
      created = Number.isNaN(ms) ? null : ms;
    } else if (typeof r.created === "number" && Number.isFinite(r.created)) {
      created = r.created < 1e12 ? r.created * 1000 : r.created;
    }
    out.push({ id: r.id, created: created ?? 0 });
  }
  return out;
}
