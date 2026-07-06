import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { downloadAndVerify } from "../src/login/download.js";

afterEach(() => vi.unstubAllGlobals());

// Stub global fetch: the tarball URL returns a known body, the .sha256 URL
// returns a checksum for the given `sha256Body` (independent of the actual
// tarball body, so we can force a mismatch on demand).
function stubFetch(tarBody: string, sha256Body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith(".sha256")) {
        return {
          status: 200,
          ok: true,
          text: async () => sha256Body,
        } as unknown as Response;
      }
      return {
        status: 200,
        ok: true,
        body: Readable.toWeb(Readable.from([tarBody])),
      } as unknown as Response;
    }),
  );
}

describe("downloadAndVerify", () => {
  let tmp: string;

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("deletes the downloaded artifact and rejects on a sha256 mismatch", async () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-dl-"));
    const destTar = join(tmp, "agent.tar.gz");
    // Non-matching sha256 (64 zeros) regardless of the actual tarball content.
    stubFetch("not-the-real-tarball-content", "0".repeat(64));

    await expect(
      downloadAndVerify("https://x/agent.tar.gz", "https://x/agent.tar.gz.sha256", destTar),
    ).rejects.toThrow(/sha256 mismatch/i);

    expect(existsSync(destTar)).toBe(false);
  });
});
