/**
 * Minimal GitHub REST + GraphQL client (PR1, spec 2026-07-15).
 * fetch-based with fetchImpl DI (repo idiom: facetLlmClient.ts) — no octokit.
 * Error taxonomy lets syncOrg distinguish auth / rate-limit / other so the
 * connection status lands as 'auth_error' | 'rate_limited' | 'sync_error'.
 * Error messages never include the token (they carry path + status only).
 */

export interface GithubApiUser {
  id: number;
  login: string;
}

export interface GithubApiPullListItem {
  number: number;
  node_id: string;
  updated_at: string;
}

export interface GithubApiPullDetail {
  number: number;
  node_id: string;
  state: "open" | "closed";
  draft?: boolean;
  title: string;
  html_url: string;
  user: GithubApiUser | null;
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  review_comments: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

export interface GithubApiReview {
  node_id: string;
  user: GithubApiUser | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at: string | null;
}

export interface GithubApiIssue {
  number: number;
  node_id: string;
  state: "open" | "closed";
  state_reason?: string | null;
  title: string;
  html_url: string;
  user: GithubApiUser | null;
  assignees?: GithubApiUser[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by?: GithubApiUser | null;
  pull_request?: unknown;
}

export class GithubAuthError extends Error {}

export class GithubRateLimitError extends Error {
  constructor(public readonly resetAtMs: number | null) {
    super("github rate limited");
  }
}

export class GithubHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GithubClient {
  listRepoFullNames(owner: string): Promise<string[]>;
  listPullsSince(
    repoFullName: string,
    sinceIso: string | null,
  ): Promise<GithubApiPullListItem[]>;
  getPull(repoFullName: string, number: number): Promise<GithubApiPullDetail>;
  listReviews(
    repoFullName: string,
    number: number,
  ): Promise<GithubApiReview[]>;
  listIssuesSince(
    repoFullName: string,
    sinceIso: string | null,
  ): Promise<GithubApiIssue[]>;
  getIssue(repoFullName: string, number: number): Promise<GithubApiIssue>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GithubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const PER_PAGE = 100;
// Safety cap: 50 pages × 100 = 5000 rows per resource per repo per sync.
const MAX_PAGES = 50;

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");

  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "caliber-gateway",
  };

  async function request(
    path: string,
    searchParams?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetchFn(url.toString(), { method: "GET", headers });
    return handleResponse(res, path);
  }

  async function handleResponse(res: Response, path: string): Promise<unknown> {
    if (res.status === 401) {
      throw new GithubAuthError(`github token rejected (401) for ${path}`);
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      if (remaining === "0" || retryAfter !== null) {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetAtMs = reset
          ? Number(reset) * 1000
          : retryAfter
            ? Date.now() + Number(retryAfter) * 1000
            : null;
        throw new GithubRateLimitError(resetAtMs);
      }
      // 403 without rate-limit markers = PAT lacks permission for the resource.
      throw new GithubAuthError(`github access denied (403) for ${path}`);
    }
    if (!res.ok) {
      throw new GithubHttpError(res.status, `github api ${res.status} for ${path}`);
    }
    return res.json();
  }

  async function* pages(
    path: string,
    extraParams: Record<string, string>,
  ): AsyncGenerator<unknown[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const chunk = (await request(path, {
        ...extraParams,
        per_page: String(PER_PAGE),
        page: String(page),
      })) as unknown[];
      if (chunk.length === 0) return;
      yield chunk;
      if (chunk.length < PER_PAGE) return;
    }
  }

  return {
    async listRepoFullNames(owner) {
      const out: string[] = [];
      try {
        for await (const chunk of pages(`/orgs/${owner}/repos`, {})) {
          for (const repo of chunk as Array<{ full_name: string }>) {
            out.push(repo.full_name);
          }
        }
        return out;
      } catch (err) {
        // owner_login is documented as "GitHub org (or user)". A
        // fine-grained PAT scoped to a USER resource owner 404s on
        // /orgs/{owner}/repos. When that happens and the token's own
        // /user login matches `owner` (case-insensitively), fall back to
        // /user/repos?affiliation=owner — includes private repos, unlike
        // /users/{owner}/repos which is public-only and would silently
        // undercount. Any other 404 (or non-404 error) is rethrown as-is.
        if (!(err instanceof GithubHttpError) || err.status !== 404) throw err;
        const me = (await request("/user")) as GithubApiUser;
        if (me.login.toLowerCase() !== owner.toLowerCase()) throw err;
        const selfOut: string[] = [];
        for await (const chunk of pages("/user/repos", {
          affiliation: "owner",
        })) {
          for (const repo of chunk as Array<{ full_name: string }>) {
            selfOut.push(repo.full_name);
          }
        }
        return selfOut;
      }
    },

    async listPullsSince(repoFullName, sinceIso) {
      const out: GithubApiPullListItem[] = [];
      for await (const chunk of pages(`/repos/${repoFullName}/pulls`, {
        state: "all",
        sort: "updated",
        direction: "desc",
      })) {
        for (const item of chunk as GithubApiPullListItem[]) {
          if (sinceIso !== null && item.updated_at < sinceIso) return out;
          out.push(item);
        }
      }
      return out;
    },

    async getPull(repoFullName, number) {
      return (await request(
        `/repos/${repoFullName}/pulls/${number}`,
      )) as GithubApiPullDetail;
    },

    async listReviews(repoFullName, number) {
      const out: GithubApiReview[] = [];
      for await (const chunk of pages(
        `/repos/${repoFullName}/pulls/${number}/reviews`,
        {},
      )) {
        out.push(...(chunk as GithubApiReview[]));
      }
      return out;
    },

    async listIssuesSince(repoFullName, sinceIso) {
      const params: Record<string, string> = {
        state: "all",
        sort: "updated",
        direction: "desc",
      };
      if (sinceIso !== null) params.since = sinceIso;
      const out: GithubApiIssue[] = [];
      for await (const chunk of pages(`/repos/${repoFullName}/issues`, params)) {
        for (const item of chunk as GithubApiIssue[]) {
          if (item.pull_request === undefined) out.push(item);
        }
      }
      return out;
    },

    async getIssue(repoFullName, number) {
      return (await request(
        `/repos/${repoFullName}/issues/${number}`,
      )) as GithubApiIssue;
    },

    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const res = await fetchFn(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await handleResponse(res, "/graphql")) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };
      if (body.errors && body.errors.length > 0) {
        throw new GithubHttpError(
          200,
          `github graphql: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }
      if (body.data === undefined) {
        throw new GithubHttpError(200, "github graphql: empty data");
      }
      return body.data;
    },
  };
}
