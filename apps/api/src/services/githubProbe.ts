/**
 * Live PAT validation before persisting a GitHub connection (PR1).
 * Two GETs: /user (token valid?) and either /orgs/{owner}/repos?per_page=1
 * or, when `ownerLogin` is the token's own (case-insensitive) user login,
 * /user/repos?per_page=1&affiliation=owner (owner visible + repo read?).
 * `owner_login` is documented as "GitHub org (or user)" — a fine-grained
 * PAT scoped to a USER resource owner 404s on /orgs/{owner}/repos, and
 * /users/{owner}/repos would only list PUBLIC repos (a silent private-repo
 * undercount), so the self-owner case must use /user/repos instead.
 * Error messages NEVER include the token.
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

  let selfLogin: string | null = null;
  try {
    const userBody = (await userRes.json()) as { login?: unknown };
    selfLogin = typeof userBody.login === "string" ? userBody.login : null;
  } catch {
    // Malformed /user body — fall through to the org endpoint below, same
    // as any other owner whose login doesn't match the token's own.
    selfLogin = null;
  }
  const isSelfOwner =
    selfLogin !== null &&
    selfLogin.toLowerCase() === input.ownerLogin.toLowerCase();

  const repoRes = isSelfOwner
    ? await get("/user/repos?per_page=1&affiliation=owner")
    : await get(`/orgs/${input.ownerLogin}/repos?per_page=1`);
  const ownerKind = isSelfOwner ? "owner" : "org";
  if (repoRes.status === 404) {
    throw new GithubProbeError(
      "owner_not_found",
      `github ${ownerKind} '${input.ownerLogin}' not visible to this token`,
    );
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    throw new GithubProbeError(
      "bad_token",
      `token lacks repo read on the ${ownerKind}`,
    );
  }
  if (!repoRes.ok) {
    throw new GithubProbeError("network", `github repos returned ${repoRes.status}`);
  }
  const repos = (await repoRes.json()) as Array<{ full_name: string }>;
  return { sampleRepo: repos[0]?.full_name ?? null };
}
