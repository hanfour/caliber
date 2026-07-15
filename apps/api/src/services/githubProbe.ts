/**
 * Live PAT validation before persisting a GitHub connection (PR1).
 * Two GETs: /user (token valid?) and /orgs/{owner}/repos?per_page=1
 * (owner visible + repo read?). Error messages NEVER include the token.
 */
export type GithubProbeFailure = "bad_token" | "owner_not_found" | "network";

export class GithubProbeError extends Error {
  constructor(
    public readonly reason: GithubProbeFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface ProbeGithubTokenInput {
  token: string;
  ownerLogin: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function probeGithubToken(
  input: ProbeGithubTokenInput,
): Promise<{ sampleRepo: string | null }> {
  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${input.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "caliber-api",
  };

  async function get(path: string): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, { method: "GET", headers });
    } catch {
      throw new GithubProbeError("network", `github unreachable for ${path}`);
    }
  }

  const userRes = await get("/user");
  if (userRes.status === 401 || userRes.status === 403) {
    throw new GithubProbeError("bad_token", "github rejected the token");
  }
  if (!userRes.ok) {
    throw new GithubProbeError("network", `github /user returned ${userRes.status}`);
  }

  const repoRes = await get(`/orgs/${input.ownerLogin}/repos?per_page=1`);
  if (repoRes.status === 404) {
    throw new GithubProbeError(
      "owner_not_found",
      `github org '${input.ownerLogin}' not visible to this token`,
    );
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    throw new GithubProbeError("bad_token", "token lacks repo read on the org");
  }
  if (!repoRes.ok) {
    throw new GithubProbeError("network", `github repos returned ${repoRes.status}`);
  }
  const repos = (await repoRes.json()) as Array<{ full_name: string }>;
  return { sampleRepo: repos[0]?.full_name ?? null };
}
