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
});
