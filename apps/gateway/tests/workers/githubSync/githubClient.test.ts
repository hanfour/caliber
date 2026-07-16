import { describe, it, expect, vi } from "vitest";
import {
  createGithubClient,
  GithubAuthError,
  GithubHttpError,
  GithubRateLimitError,
} from "../../../src/workers/githubSync/githubClient.js";

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textRes(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}

/** fetchImpl returning queued responses in order. */
function fetchQueue(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

const client = (fetchImpl: unknown) =>
  createGithubClient({
    token: "github_pat_TESTTOKEN00000000000000",
    fetchImpl: fetchImpl as typeof fetch,
  });

describe("createGithubClient", () => {
  it("sends Bearer auth + API version headers", async () => {
    const fetchImpl = fetchQueue(jsonRes([]));
    await client(fetchImpl).listRepoFullNames("acme");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/orgs/acme/repos");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(
      "Bearer github_pat_TESTTOKEN00000000000000",
    );
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("listPullsSince stops paging at the since cutoff", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: 200 - i,
      node_id: `PR_${200 - i}`,
      updated_at: "2026-07-10T00:00:00Z",
    }));
    // second page is older than `since` — must be cut off, no page 3 fetched
    const page2 = Array.from({ length: 100 }, (_, i) => ({
      number: 100 - i,
      node_id: `PR_${100 - i}`,
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const fetchImpl = fetchQueue(jsonRes(page1), jsonRes(page2));
    const items = await client(fetchImpl).listPullsSince(
      "acme/web",
      "2026-07-01T00:00:00Z",
    );
    expect(items).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("listIssuesSince filters out pull requests", async () => {
    const fetchImpl = fetchQueue(
      jsonRes([
        { number: 1, node_id: "I_1", updated_at: "2026-07-10T00:00:00Z" },
        {
          number: 2,
          node_id: "PR_2",
          updated_at: "2026-07-10T00:00:00Z",
          pull_request: { url: "x" },
        },
      ]),
    );
    const items = await client(fetchImpl).listIssuesSince("acme/web", null);
    expect(items.map((i) => i.node_id)).toEqual(["I_1"]);
  });

  it("maps 401 to GithubAuthError", async () => {
    const fetchImpl = fetchQueue(jsonRes({ message: "Bad credentials" }, 401));
    await expect(client(fetchImpl).getPull("acme/web", 1)).rejects.toBeInstanceOf(
      GithubAuthError,
    );
  });

  it("maps 403 + x-ratelimit-remaining:0 to GithubRateLimitError with reset", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "rate limited" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1783700000",
      }),
    );
    const err = await client(fetchImpl)
      .getPull("acme/web", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect((err as GithubRateLimitError).resetAtMs).toBe(1783700000 * 1000);
  });

  // Guard A: malformed rate-limit headers must not produce NaN — resetAtMs
  // should degrade to null rather than a nonsense finite number.
  it("malformed x-ratelimit-reset → GithubRateLimitError with resetAtMs null (not NaN)", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "rate limited" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "not-a-number",
      }),
    );
    const err = await client(fetchImpl)
      .getPull("acme/web", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect((err as GithubRateLimitError).resetAtMs).toBeNull();
  });

  // Guard B: a bare 429 (no x-ratelimit-remaining/-reset or retry-after)
  // must still classify as rate-limited, not auth_error — an auth_error
  // permanently pauses the org's sync schedule (see interval.ts), which
  // would be wrong for a transient rate limit. A bare 403 (no markers)
  // still means "PAT lacks permission" → GithubAuthError.
  it("bare 429 (no markers) → GithubRateLimitError with resetAtMs null", async () => {
    const fetchImpl = fetchQueue(jsonRes({ message: "too many requests" }, 429));
    const err = await client(fetchImpl)
      .getPull("acme/web", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect((err as GithubRateLimitError).resetAtMs).toBeNull();
  });

  it("bare 403 (no markers) → GithubAuthError", async () => {
    const fetchImpl = fetchQueue(jsonRes({ message: "Forbidden" }, 403));
    const err = await client(fetchImpl)
      .getPull("acme/web", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAuthError);
  });

  // owner_login is documented as "GitHub org (or user)". A fine-grained PAT
  // scoped to a USER resource owner 404s on /orgs/{owner}/repos; when that
  // happens and /user's login matches `owner` (case-insensitively), fall
  // back to /user/repos?affiliation=owner (private repos included) rather
  // than /users/{owner}/repos (public-only — would silently undercount).
  it("listRepoFullNames: org 404 + /user login matches owner → falls back to /user/repos?affiliation=owner", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "Not Found" }, 404),
      jsonRes({ login: "hanfour" }),
      jsonRes([{ full_name: "hanfour/dotfiles" }]),
    );
    const names = await client(fetchImpl).listRepoFullNames("HanFour");
    expect(names).toEqual(["hanfour/dotfiles"]);
    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls[0]).toContain("/orgs/HanFour/repos");
    expect(urls[1]).toContain("/user");
    expect(urls[2]).toContain("/user/repos");
    expect(urls[2]).toContain("affiliation=owner");
  });

  it("listRepoFullNames: org 404 + /user login mismatch → rethrows the 404 GithubHttpError", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "Not Found" }, 404),
      jsonRes({ login: "someoneelse" }),
    );
    const err = await client(fetchImpl)
      .listRepoFullNames("acme")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubHttpError);
    expect((err as GithubHttpError).status).toBe(404);
  });

  // Guard: a malformed /user body (no `login`, e.g. an empty object) must
  // not throw a raw TypeError out of `.toLowerCase()` — it should rethrow
  // the original org-404 GithubHttpError, same mismatch behavior as when
  // /user's login simply doesn't match.
  it("listRepoFullNames: org 404 + /user body missing login → rethrows the original 404 GithubHttpError", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ message: "Not Found" }, 404),
      jsonRes({}),
    );
    const err = await client(fetchImpl)
      .listRepoFullNames("acme")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubHttpError);
    expect((err as GithubHttpError).status).toBe(404);
  });

  it("graphql surfaces GraphQL errors and returns data otherwise", async () => {
    const fetchImpl = fetchQueue(
      jsonRes({ data: { organization: { projectsV2: { nodes: [] } } } }),
    );
    const data = await client(fetchImpl).graphql<{ organization: unknown }>(
      "query { viewer { login } }",
      {},
    );
    expect(data.organization).toBeDefined();

    const bad = fetchQueue(jsonRes({ errors: [{ message: "nope" }] }));
    await expect(client(bad).graphql("query {}", {})).rejects.toThrow("nope");
  });

  it("getPullDiff sends the diff accept header and returns raw text", async () => {
    const diffBody = "diff --git a/x b/x\n+1";
    const fetchImpl = fetchQueue(textRes(diffBody));
    const diff = await client(fetchImpl).getPullDiff("acme/web", 42);
    expect(diff).toBe(diffBody);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/repos/acme/web/pulls/42");
    const headers = init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/vnd.github.diff");
  });

  it("getPullDiff: 401 on the text path still maps to GithubAuthError (shared taxonomy)", async () => {
    const fetchImpl = fetchQueue(textRes("Bad credentials", 401));
    await expect(
      client(fetchImpl).getPullDiff("acme/web", 42),
    ).rejects.toBeInstanceOf(GithubAuthError);
  });

  it("listReviewComments paginates (100 then <100) and returns bodies", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      body: `comment ${i}`,
      user: { id: 1, login: "alice" },
      path: "src/a.ts",
    }));
    const page2 = [
      { body: "comment last", user: { id: 2, login: "bob" }, path: "src/b.ts" },
    ];
    const fetchImpl = fetchQueue(jsonRes(page1), jsonRes(page2));
    const comments = await client(fetchImpl).listReviewComments("acme/web", 42);
    expect(comments).toHaveLength(101);
    expect(comments[0]!.body).toBe("comment 0");
    expect(comments[100]!.body).toBe("comment last");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls[0]).toContain("/repos/acme/web/pulls/42/comments");
  });
});
