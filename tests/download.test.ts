import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, assetUrl, downloadTo, fetchSha256, resolvePlatform, verifySha256 } from "../src/login/download.js";

describe("resolvePlatform", () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origArch = Object.getOwnPropertyDescriptor(process, "arch")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", origPlatform);
    Object.defineProperty(process, "arch", origArch);
  });

  it("maps darwin/arm64", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    expect(resolvePlatform()).toEqual({ platform: "darwin", arch: "arm64" });
  });

  it("maps darwin/x64 to amd64", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "x64" });
    expect(resolvePlatform()).toEqual({ platform: "darwin", arch: "amd64" });
  });

  it("maps linux/arm64", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    expect(resolvePlatform()).toEqual({ platform: "linux", arch: "arm64" });
  });

  // Ops-review guard: any platform other than darwin/linux (e.g. Windows)
  // previously silently fell through to "linux", so a Windows member would
  // get a linux tarball plus an `xdg-open` call that doesn't exist on their
  // machine. There is no macOS/Linux binary to fall back to, so fail loudly
  // instead of guessing.
  it("throws a clear error for an unsupported platform (e.g. win32)", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
    expect(() => resolvePlatform()).toThrow(/unsupported platform/i);
  });
});

describe("assetName", () => {
  it("replaces slashes in the agent tag with underscores", () => {
    expect(assetName("agent/v0.2.0", "darwin", "arm64")).toBe("caliber-agent-agent_v0.2.0-darwin-arm64.tar.gz");
  });

  it("leaves tags without slashes untouched", () => {
    expect(assetName("v0.2.0", "linux", "amd64")).toBe("caliber-agent-v0.2.0-linux-amd64.tar.gz");
  });
});

describe("assetUrl", () => {
  it("keeps the slash in the release tag path", () => {
    const url = assetUrl("hanfour/caliber", "agent/v0.2.0", "caliber-agent-agent_v0.2.0-darwin-arm64.tar.gz");
    expect(url).toBe(
      "https://github.com/hanfour/caliber/releases/download/agent/v0.2.0/caliber-agent-agent_v0.2.0-darwin-arm64.tar.gz",
    );
  });
});

describe("verifySha256", () => {
  let tmp: string;
  let filePath: string;

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns true when the digest matches a bare hex string", () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-sha-"));
    filePath = join(tmp, "payload.bin");
    const content = "hello world";
    writeFileSync(filePath, content);
    const digest = createHash("sha256").update(content).digest("hex");
    expect(verifySha256(filePath, digest)).toBe(true);
  });

  it("returns true when the digest is uppercase", () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-sha-"));
    filePath = join(tmp, "payload.bin");
    const content = "hello world";
    writeFileSync(filePath, content);
    const digest = createHash("sha256").update(content).digest("hex").toUpperCase();
    expect(verifySha256(filePath, digest)).toBe(true);
  });

  it("returns true against a shasum sidecar format (hex + filename)", () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-sha-"));
    filePath = join(tmp, "payload.bin");
    const content = "hello world";
    writeFileSync(filePath, content);
    const digest = createHash("sha256").update(content).digest("hex");
    expect(verifySha256(filePath, `${digest}  payload.bin\n`)).toBe(true);
  });

  it("returns false when the digest does not match", () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-sha-"));
    filePath = join(tmp, "payload.bin");
    writeFileSync(filePath, "hello world");
    expect(verifySha256(filePath, "0".repeat(64))).toBe(false);
  });
});

// Node's fetch has NO default timeout: a connection that stalls after the
// handshake hangs the promise forever, so every download-path request must
// carry an abort/timeout signal.
describe("request timeouts", () => {
  let tmp: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("downloadTo passes an abort/timeout signal and writes the body", async () => {
    tmp = mkdtempSync(join(tmpdir(), "caliber-dl-"));
    const dest = join(tmp, "asset.tar.gz");
    const mock = vi.fn(async () => new Response("tarball-bytes"));
    vi.stubGlobal("fetch", mock);
    await downloadTo("https://example.test/asset.tar.gz", dest);
    expect(readFileSync(dest, "utf-8")).toBe("tarball-bytes");
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchSha256 passes an abort/timeout signal", async () => {
    const mock = vi.fn(async () => new Response(`${"a".repeat(64)}  asset.tar.gz\n`));
    vi.stubGlobal("fetch", mock);
    await expect(fetchSha256("https://example.test/asset.tar.gz.sha256")).resolves.toBe("a".repeat(64));
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
