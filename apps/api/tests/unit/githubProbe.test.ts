import { describe, it, expect, vi } from "vitest";
import {
  probeGithubToken,
  GithubProbeError,
} from "../../src/services/githubProbe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fetchQueue(...responses: Array<Response | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn as unknown as typeof fetch;
}

const INPUT = { token: "github_pat_TESTTOKEN00000000000000", ownerLogin: "acme" };

describe("probeGithubToken", () => {
  it("returns a sample repo on success", async () => {
    const fetchImpl = fetchQueue(
      json({ login: "bot" }),
      json([{ full_name: "acme/web" }]),
    );
    const res = await probeGithubToken({ ...INPUT, fetchImpl });
    expect(res).toEqual({ sampleRepo: "acme/web" });
  });

  it("401 on /user → bad_token", async () => {
    const fetchImpl = fetchQueue(json({ message: "Bad credentials" }, 401));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubProbeError);
    expect((err as GithubProbeError).reason).toBe("bad_token");
    expect((err as GithubProbeError).message).not.toContain(INPUT.token);
  });

  it("404 on org repos → owner_not_found", async () => {
    const fetchImpl = fetchQueue(json({}), json({ message: "Not Found" }, 404));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect((err as GithubProbeError).reason).toBe("owner_not_found");
  });

  it("fetch rejection → network", async () => {
    const fetchImpl = fetchQueue(new TypeError("fetch failed"));
    const err = await probeGithubToken({ ...INPUT, fetchImpl }).catch((e) => e);
    expect((err as GithubProbeError).reason).toBe("network");
  });

  // owner_login is documented as "GitHub org (or user)" — a fine-grained PAT
  // scoped to a USER resource owner 404s on /orgs/{owner}/repos, and
  // /users/{owner}/repos only lists PUBLIC repos (silent private-repo
  // undercount), so when ownerLogin matches the token's own /user login we
  // must probe GET /user/repos?affiliation=owner instead.
  it("user-owner PAT: ownerLogin matches /user login → probes /user/repos, not /orgs/...", async () => {
    const fetchImpl = fetchQueue(
      json({ login: "hanfour" }),
      json([{ full_name: "hanfour/dotfiles" }]),
    );
    const res = await probeGithubToken({
      ...INPUT,
      ownerLogin: "hanfour",
      fetchImpl,
    });
    expect(res).toEqual({ sampleRepo: "hanfour/dotfiles" });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const secondUrl = String(calls[1]![0]);
    expect(secondUrl).toContain("/user/repos");
    expect(secondUrl).toContain("affiliation=owner");
    expect(secondUrl).not.toContain("/orgs/");
  });

  it("user-owner PAT: match is case-insensitive", async () => {
    const fetchImpl = fetchQueue(
      json({ login: "hanfour" }),
      json([{ full_name: "hanfour/dotfiles" }]),
    );
    const res = await probeGithubToken({
      ...INPUT,
      ownerLogin: "HanFour",
      fetchImpl,
    });
    expect(res).toEqual({ sampleRepo: "hanfour/dotfiles" });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondUrl = String(calls[1]![0]);
    expect(secondUrl).toContain("/user/repos");
  });

  it("org owner (login differs from /user login) still uses the org endpoint", async () => {
    const fetchImpl = fetchQueue(
      json({ login: "bot" }),
      json([{ full_name: "acme/web" }]),
    );
    const res = await probeGithubToken({ ...INPUT, ownerLogin: "acme", fetchImpl });
    expect(res).toEqual({ sampleRepo: "acme/web" });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondUrl = String(calls[1]![0]);
    expect(secondUrl).toContain("/orgs/acme/repos");
  });
});
