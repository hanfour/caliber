import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  readKeychainBundle,
  writeKeychainBundle,
} from "../../src/runtime/keychainReader.js";

/**
 * Each test spins up a tiny unix-socket server in tmpdir that mimics
 * the real keychain helper's wire protocol. Lets us cover happy path,
 * error response, malformed response, missing socket, timeout, …
 * without launching the real /usr/bin/security tool.
 */
let server: Server | null = null;
let serverConnections: Set<Socket> = new Set();
let socketPath: string;
const silentLogger = { warn: () => {} };

beforeEach(() => {
  socketPath = path.join(
    os.tmpdir(),
    `aide-keychain-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  serverConnections = new Set();
});

afterEach(async () => {
  // server.close() waits for outstanding connections to finish, which
  // would hang the timeout test where we deliberately leave a
  // connection idle. node:net Server has no closeAllConnections() (that
  // method is on http.Server), so track + destroy ourselves.
  for (const conn of serverConnections) {
    conn.destroy();
  }
  serverConnections.clear();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
});

function trackConn(conn: Socket): void {
  serverConnections.add(conn);
  conn.on("close", () => serverConnections.delete(conn));
}

function startFakeHelper(reply: string | ((line: string) => string)): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((conn) => {
      trackConn(conn);
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        const out = typeof reply === "function" ? reply(line) : reply;
        conn.write(out);
        conn.end();
      });
    });
    server.listen(socketPath, () => resolve());
  });
}

describe("readKeychainBundle", () => {
  it("happy path → parses bundle into KeychainBundle", async () => {
    await startFakeHelper(
      JSON.stringify({
        ok: true,
        bundle: {
          access_token: "sk-ant-oat01-AAA",
          refresh_token: "sk-ant-ort01-BBB",
          expires_at: "2026-12-31T00:00:00Z",
        },
      }) + "\n",
    );
    const got = await readKeychainBundle({ endpoint: socketPath, logger: silentLogger });
    expect(got).not.toBeNull();
    expect(got!.accessToken).toBe("sk-ant-oat01-AAA");
    expect(got!.refreshToken).toBe("sk-ant-ort01-BBB");
    expect(got!.expiresAt.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("helper returns ok:false → null + warn", async () => {
    await startFakeHelper(
      JSON.stringify({ ok: false, error: "keychain read failed" }) + "\n",
    );
    const got = await readKeychainBundle({ endpoint: socketPath, logger: silentLogger });
    expect(got).toBeNull();
  });

  it("malformed bundle → null", async () => {
    await startFakeHelper(
      JSON.stringify({
        ok: true,
        bundle: { access_token: 123, refresh_token: null, expires_at: "x" },
      }) + "\n",
    );
    const got = await readKeychainBundle({ endpoint: socketPath, logger: silentLogger });
    expect(got).toBeNull();
  });

  it("non-JSON response → null", async () => {
    await startFakeHelper("not-json\n");
    const got = await readKeychainBundle({ endpoint: socketPath, logger: silentLogger });
    expect(got).toBeNull();
  });

  it("invalid expires_at date string → null", async () => {
    await startFakeHelper(
      JSON.stringify({
        ok: true,
        bundle: {
          access_token: "a",
          refresh_token: "b",
          expires_at: "not-a-date",
        },
      }) + "\n",
    );
    const got = await readKeychainBundle({ endpoint: socketPath, logger: silentLogger });
    expect(got).toBeNull();
  });

  it("socket missing → null + warn", async () => {
    // Don't start a server; ENOENT.
    const got = await readKeychainBundle({
      endpoint: "/tmp/this-socket-does-not-exist-xyz.sock",
      logger: silentLogger,
    });
    expect(got).toBeNull();
  });

  it("server holds connection open → timeout → null", async () => {
    server = createServer((conn) => {
      // accept but never reply
      trackConn(conn);
    });
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    const start = Date.now();
    const got = await readKeychainBundle({
      endpoint: socketPath,
      timeoutMs: 200,
      logger: silentLogger,
    });
    expect(got).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("writeKeychainBundle", () => {
  const sampleBundle = {
    accessToken: "sk-ant-oat01-AAA",
    refreshToken: "sk-ant-ort01-BBB",
    expiresAt: new Date("2026-12-31T00:00:00Z"),
  };

  it("happy path → returns true; helper receives op:write payload", async () => {
    let receivedLine = "";
    server = createServer((conn) => {
      trackConn(conn);
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        receivedLine = buffer.slice(0, nl);
        conn.write(JSON.stringify({ ok: true }) + "\n");
        conn.end();
      });
    });
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));

    const ok = await writeKeychainBundle({
      endpoint: socketPath,
      bundle: sampleBundle,
      logger: silentLogger,
    });
    expect(ok).toBe(true);

    const parsed = JSON.parse(receivedLine);
    expect(parsed.op).toBe("write");
    expect(parsed.bundle).toEqual({
      access_token: "sk-ant-oat01-AAA",
      refresh_token: "sk-ant-ort01-BBB",
      expires_at: "2026-12-31T00:00:00.000Z",
    });
  });

  it("helper returns ok:false → returns false", async () => {
    server = createServer((conn) => {
      trackConn(conn);
      conn.on("data", () => {
        conn.write(JSON.stringify({ ok: false, error: "boom" }) + "\n");
        conn.end();
      });
    });
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));

    const ok = await writeKeychainBundle({
      endpoint: socketPath,
      bundle: sampleBundle,
      logger: silentLogger,
    });
    expect(ok).toBe(false);
  });

  it("socket missing → returns false (never throws)", async () => {
    const ok = await writeKeychainBundle({
      endpoint: "/tmp/this-socket-does-not-exist-zzz.sock",
      bundle: sampleBundle,
      logger: silentLogger,
    });
    expect(ok).toBe(false);
  });

  it("server holds connection open → timeout → returns false", async () => {
    server = createServer((conn) => trackConn(conn));
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    const start = Date.now();
    const ok = await writeKeychainBundle({
      endpoint: socketPath,
      bundle: sampleBundle,
      timeoutMs: 200,
      logger: silentLogger,
    });
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
