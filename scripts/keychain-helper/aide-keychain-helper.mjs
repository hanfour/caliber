#!/usr/bin/env node
/**
 * aide-keychain-helper — tiny TCP bridge that lets the gateway
 * container read the host macOS Keychain entry
 * `Claude Code-credentials`.
 *
 * Why this exists: aide gateway runs in Docker; macOS Keychain lives
 * on the host. The container has no way to invoke
 * `security find-generic-password` itself, so this helper exposes
 * the keychain entry over a localhost TCP socket the container
 * reaches via host.docker.internal. See
 * docs/OAUTH_REFRESH_DESIGN.md option A.
 *
 * Why TCP not unix-socket: Docker Desktop on macOS bind-mounts unix
 * sockets through VirtioFS, which doesn't preserve socket inode
 * semantics — the file appears in the container but connect()
 * returns ECONNREFUSED. TCP via host.docker.internal works
 * reliably.
 *
 * Wire format: newline-delimited JSON requests/responses. Each
 * request must include `auth` matching the bearer token written to
 * `$HOME/.aide/keychain.token` at first start.
 *
 *   request:  {"op":"read","auth":"<token>"}
 *   response: {"ok":true,"bundle":{"access_token":"…","refresh_token":"…","expires_at":"2026-…Z"}}
 *   error:    {"ok":false,"error":"…"}
 *
 * Auth: random 256-bit bearer token, stored 0600. The container
 * mounts the token file (read-only) into the container so the
 * gateway can present it. Anyone who can read the token already
 * has the same UID as the keychain owner, so they could run
 * `security find-generic-password` themselves — no extra exposure.
 *
 * Lifecycle: managed by launchd (see aide-keychain-helper.plist).
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HOST = process.env.AIDE_KEYCHAIN_HOST || "127.0.0.1";
const PORT = parseInt(process.env.AIDE_KEYCHAIN_PORT || "47823", 10);
const TOKEN_PATH =
  process.env.AIDE_KEYCHAIN_TOKEN_PATH ||
  path.join(os.homedir(), ".aide", "keychain.token");
const KEYCHAIN_ENTRY =
  process.env.AIDE_KEYCHAIN_ENTRY || "Claude Code-credentials";

/** Per-connection idle timeout. Keep tight — clients should send + go. */
const CONN_IDLE_MS = 5_000;

/**
 * In-memory cache TTL for the keychain bundle. macOS' keychain
 * subsystem is fine with hundreds of reads/sec but a buggy gateway
 * loop hammering us serves no one — cache the parsed bundle for
 * 1s. Real refresh frequency is bounded by the access_token TTL
 * (hours), so 1s is well below the freshness floor caller cares
 * about.
 */
const READ_CACHE_TTL_MS = 1_000;

function log(level, msg, extra) {
  const obj = {
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    msg,
    ...extra,
  };
  // stderr so launchd / journalctl pick it up
  process.stderr.write(JSON.stringify(obj) + "\n");
}

/**
 * Reshape Claude Code's keychain JSON into aide's stored format.
 * Mirrors the python one-liner in ReonboardDialog.tsx so what aide
 * gets via socket matches what an operator gets via copy-paste.
 */
function reshapeBundle(raw) {
  const oa = raw?.claudeAiOauth;
  if (!oa) {
    throw new Error("keychain entry missing claudeAiOauth field");
  }
  if (
    typeof oa.accessToken !== "string" ||
    typeof oa.refreshToken !== "string" ||
    typeof oa.expiresAt !== "number"
  ) {
    throw new Error("keychain entry malformed (accessToken/refreshToken/expiresAt)");
  }
  return {
    access_token: oa.accessToken,
    refresh_token: oa.refreshToken,
    expires_at: new Date(oa.expiresAt).toISOString(),
  };
}

/** READ_CACHE_TTL_MS-bounded cache of the last successful read. */
let readCache = { at: 0, value: null };
/** Coalesce concurrent reads: if a request is in flight, others wait. */
let inflight = null;

async function readKeychain() {
  const now = Date.now();
  if (readCache.value && now - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.value;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // -w flag prints just the password (the JSON blob) to stdout.
      // -s matches the service name exactly.
      const { stdout } = await execFileP(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_ENTRY, "-w"],
        { timeout: 3_000 },
      );
      const raw = JSON.parse(stdout);
      const value = reshapeBundle(raw);
      readCache = { at: Date.now(), value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Inverse of reshapeBundle — takes aide's flat snake_case shape and
 * reconstructs Claude Code's keychain envelope (camelCase under
 * `claudeAiOauth`, expiresAt as unix-ms).
 */
function unshapeBundle(bundle) {
  if (
    !bundle ||
    typeof bundle.access_token !== "string" ||
    typeof bundle.refresh_token !== "string" ||
    typeof bundle.expires_at !== "string"
  ) {
    throw new Error("write payload missing access_token/refresh_token/expires_at");
  }
  const expiresAtMs = new Date(bundle.expires_at).getTime();
  if (Number.isNaN(expiresAtMs)) {
    throw new Error("write payload expires_at not a valid date");
  }
  return {
    claudeAiOauth: {
      accessToken: bundle.access_token,
      refreshToken: bundle.refresh_token,
      expiresAt: expiresAtMs,
      // Preserve any subscription / scope metadata the existing
      // entry has — read it first and merge. Falls back to defaults
      // if the keychain is brand new (which shouldn't happen but…).
    },
  };
}

async function writeKeychain(bundle) {
  // Merge with existing entry to preserve subscriptionType / scopes /
  // any other fields the Claude Code app puts there. We only own the
  // token triplet.
  const reshaped = unshapeBundle(bundle);
  let existing = {};
  try {
    const { stdout } = await execFileP(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_ENTRY, "-w"],
      { timeout: 3_000 },
    );
    existing = JSON.parse(stdout);
  } catch {
    // No existing entry — fine, we'll create it. (Unlikely path; aide
    // only writes to keychain after operator already onboarded.)
  }
  const merged = {
    ...existing,
    claudeAiOauth: {
      ...(existing?.claudeAiOauth ?? {}),
      ...reshaped.claudeAiOauth,
    },
  };
  const payload = JSON.stringify(merged);

  // -U: update if exists, create if not. -s service, -a account
  // (use the same UID-suffixed account name claude code itself uses
  // — pull from existing if we have it). -w password (the JSON blob).
  const accountName =
    typeof existing?.account === "string"
      ? existing.account
      : process.env.USER || "default";
  await execFileP(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_ENTRY, "-a", accountName, "-w", payload],
    { timeout: 3_000 },
  );

  // Invalidate read cache so the next read sees what we just wrote
  // (otherwise the 1s cache could mask the new value briefly).
  readCache = { at: 0, value: null };
}

async function handleCommand(line, expectedToken) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: "request not valid JSON" };
  }
  if (!req || typeof req !== "object") {
    return { ok: false, error: "request must be a JSON object" };
  }
  // Constant-time compare so timing doesn't leak the token.
  const auth = typeof req.auth === "string" ? req.auth : "";
  const eq =
    auth.length === expectedToken.length &&
    crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expectedToken));
  if (!eq) {
    return { ok: false, error: "unauthorized" };
  }

  switch (req.op) {
    case "read": {
      try {
        const bundle = await readKeychain();
        return { ok: true, bundle };
      } catch (err) {
        // Don't expose stderr details — security tool stderr can include
        // the keychain item name + path in some cases. Surface a generic
        // message; ops can read the helper's own log for the real error.
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", "read failed", { err: msg });
        return { ok: false, error: "keychain read failed" };
      }
    }
    case "write": {
      // Phase 2.6: aide pushes its own freshly-refreshed bundle into
      // keychain so the host Claude Code app inherits it (and we
      // both stop racing on the next anthropic-side rotation).
      try {
        await writeKeychain(req.bundle);
        log("info", "write ok");
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", "write failed", { err: msg });
        return { ok: false, error: "keychain write failed" };
      }
    }
    case "ping":
      return { ok: true, pong: true };
    default:
      return { ok: false, error: `unknown op: ${String(req.op)}` };
  }
}

function ensureTokenDir() {
  const dir = path.dirname(TOKEN_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
}

function loadOrCreateToken() {
  ensureTokenDir();
  try {
    const existing = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not present, create
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

function startServer() {
  const expectedToken = loadOrCreateToken();
  log("info", "loaded token", { tokenPath: TOKEN_PATH });

  const server = net.createServer((conn) => {
    conn.setTimeout(CONN_IDLE_MS);
    conn.on("timeout", () => {
      conn.destroy();
    });
    conn.on("error", (err) => {
      log("warn", "conn error", { err: err.message });
    });

    let buffer = "";
    conn.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const reply = await handleCommand(line, expectedToken);
        conn.write(JSON.stringify(reply) + "\n");
      }
    });
  });

  server.listen(PORT, HOST, () => {
    log("info", "listening", {
      host: HOST,
      port: PORT,
      entry: KEYCHAIN_ENTRY,
    });
  });

  const shutdown = (sig) => {
    log("info", "shutdown", { signal: sig });
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
