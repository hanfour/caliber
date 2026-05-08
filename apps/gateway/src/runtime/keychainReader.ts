/**
 * Client for the host-side `aide-keychain-helper` TCP server.
 *
 * Phase 2 of the OAuth refresh redesign (issue #93, option B').
 * Lets the gateway fetch the macOS Keychain bundle without itself
 * having any privileged access — the helper daemon does the
 * `security find-generic-password` work and exposes the result via
 * a localhost TCP port the operator reaches from the container via
 * host.docker.internal.
 *
 * Wire format defined in scripts/keychain-helper/README.md. Each
 * request must include a bearer `auth` token; the gateway reads
 * the token from a file the operator bind-mounts at
 * `/run/aide-keychain.token` (path overridable via env).
 *
 * Why TCP, not unix-socket: Docker Desktop on macOS bind-mounts unix
 * sockets through VirtioFS, which doesn't preserve socket inode
 * semantics — the file appears in the container but connect()
 * returns ECONNREFUSED. TCP via host.docker.internal works
 * reliably across Docker Desktop versions.
 *
 * Failure model:
 * - Endpoint not configured → returns null. Caller falls back to
 *   whatever it would have done without keychain re-read.
 * - Token file missing / unreadable → returns null with warn log.
 * - Endpoint reachable but read fails (timeout, malformed response,
 *   helper returned ok:false) → returns null with warn log.
 * - Never throws.
 */

import { connect } from "node:net";
import { readFile } from "node:fs/promises";

/**
 * Cache the bearer token in process memory for this long. Trade-off
 * is operator UX: rotate the token via re-running install.sh and you
 * have to wait up to 60s for the gateway to pick it up. That's
 * acceptable — token rotation is rare and the alternative is per-
 * request fs.readFile during the lead window when refresh is being
 * hammered by parallel requests.
 *
 * Keyed by tokenPath so different paths cache independently (cron +
 * inline could hypothetically use different mounts).
 */
const TOKEN_CACHE_TTL_MS = 60_000;
const tokenCache = new Map<string, { at: number; token: string }>();

async function readTokenCached(
  tokenPath: string,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<string | null> {
  const now = Date.now();
  const cached = tokenCache.get(tokenPath);
  if (cached && now - cached.at < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!token || token.length < 32) {
      log.warn(
        { tokenPath, len: token.length },
        "keychain helper token unreadable / too short",
      );
      return null;
    }
    tokenCache.set(tokenPath, { at: now, token });
    return token;
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tokenPath,
      },
      "keychain helper token file unavailable",
    );
    // Don't cache failure — operator may have just installed the
    // helper; we want to retry on the next call.
    return null;
  }
}

export interface KeychainBundle {
  /** Anthropic OAuth access_token (sk-ant-oat01-…). */
  accessToken: string;
  /** Anthropic OAuth refresh_token (sk-ant-ort01-…). */
  refreshToken: string;
  /** ISO 8601 string parsed into Date. */
  expiresAt: Date;
}

interface ReadKeychainOptions {
  /**
   * `host:port` of the helper. Usually
   * `opts.env.GATEWAY_KEYCHAIN_HELPER_ENDPOINT` —
   * `host.docker.internal:47823` in the standard compose setup.
   *
   * Legacy: a unix socket path is also accepted (no `:` present)
   * for tests that already wired around a unix socket.
   */
  endpoint: string;
  /**
   * Path to the bearer token file. Read fresh on every call (cheap
   * — token is ~64 chars; file IO is microseconds). Operator
   * bind-mounts the host's ~/.aide/keychain.token into the
   * container at this path. Required when endpoint is TCP; ignored
   * for unix socket (legacy).
   */
  tokenPath?: string;
  /** Read timeout in ms. Default 3000. */
  timeoutMs?: number;
  /** Pino-style logger. Optional — falls back to console.warn. */
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

interface HelperResponse {
  ok: boolean;
  bundle?: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_at?: unknown;
  };
  error?: unknown;
}

/**
 * Public type for callers that want to inject a fake reader (tests,
 * future Linux/Windows adapters, etc.) without coupling to the
 * implementation function's exact inferred signature.
 */
export type KeychainReader = (
  opts: ReadKeychainOptions,
) => Promise<KeychainBundle | null>;

/**
 * Connect to the helper, send `{op:"read",auth:"<token>"}`, parse
 * the response. Returns the keychain bundle or null on any failure.
 */
export const readKeychainBundle: KeychainReader = async (
  opts: ReadKeychainOptions,
): Promise<KeychainBundle | null> => {
  const log = opts.logger ?? { warn: (o: unknown, m?: string) =>
    process.stderr.write(JSON.stringify({ msg: m, ...((o as object) ?? {}) }) + "\n") };
  const timeoutMs = opts.timeoutMs ?? 3_000;

  // Endpoint parsing: "host:port" → TCP; otherwise treat as unix
  // socket path (legacy / tests).
  const isTcp = opts.endpoint.includes(":") && !opts.endpoint.startsWith("/");
  let token: string | null = null;
  if (isTcp) {
    if (!opts.tokenPath) {
      log.warn(
        { endpoint: opts.endpoint },
        "keychain helper TCP endpoint requires tokenPath — disabled",
      );
      return null;
    }
    token = await readTokenCached(opts.tokenPath, log);
    if (!token) return null;
  }

  return new Promise<KeychainBundle | null>((resolve) => {
    let settled = false;
    const settle = (value: KeychainBundle | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let sock;
    if (isTcp) {
      const colon = opts.endpoint.lastIndexOf(":");
      const host = opts.endpoint.slice(0, colon);
      const port = parseInt(opts.endpoint.slice(colon + 1), 10);
      sock = connect(port, host);
    } else {
      sock = connect(opts.endpoint);
    }
    let buffer = "";

    const timer = setTimeout(() => {
      log.warn(
        { endpoint: opts.endpoint, timeoutMs },
        "keychain helper read timed out",
      );
      sock.destroy();
      settle(null);
    }, timeoutMs);

    sock.on("connect", () => {
      const req = isTcp
        ? JSON.stringify({ op: "read", auth: token }) + "\n"
        : '{"op":"read"}\n';
      sock.write(req);
    });

    sock.on("data", (chunk) => {
      // Re-entry guard: once we've parsed the first \n-terminated line
      // and called settle(), any further data events from a chunky
      // upstream or from the helper writing more than one reply per
      // request would re-run parse against stale buffer. Today's
      // helper sends exactly one reply per connection so this is
      // theoretical, but cheap to harden.
      if (settled) return;
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      sock.end(); // we only need one response
      clearTimeout(timer);

      let parsed: HelperResponse;
      try {
        parsed = JSON.parse(line) as HelperResponse;
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "keychain helper response not valid JSON",
        );
        settle(null);
        return;
      }

      if (!parsed.ok || !parsed.bundle) {
        log.warn(
          { error: String(parsed.error ?? "unknown") },
          "keychain helper returned error",
        );
        settle(null);
        return;
      }

      const { access_token, refresh_token, expires_at } = parsed.bundle;
      if (
        typeof access_token !== "string" ||
        typeof refresh_token !== "string" ||
        typeof expires_at !== "string"
      ) {
        log.warn(
          { bundle: parsed.bundle },
          "keychain helper bundle malformed",
        );
        settle(null);
        return;
      }
      const expDate = new Date(expires_at);
      if (Number.isNaN(expDate.getTime())) {
        log.warn(
          { expires_at },
          "keychain helper bundle expires_at not a valid date",
        );
        settle(null);
        return;
      }
      settle({
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: expDate,
      });
    });

    sock.on("error", (err) => {
      // Re-entry guard mirrors the data handler — sock.destroy()
      // from the timeout path emits 'error' (ECONNRESET / "premature
      // close"), which would otherwise log a spurious "unavailable"
      // *after* we already settled with the timeout outcome.
      if (settled) return;
      clearTimeout(timer);
      // Most common cases: ENOENT (unix socket missing) or
      // ECONNREFUSED (TCP port not listening). Logged at warn so
      // ops can grep for it but not noisy enough to spam — caller's
      // own fallback path is the real story.
      log.warn(
        { err: err.message, endpoint: opts.endpoint },
        "keychain helper unavailable",
      );
      settle(null);
    });
  });
};

// ─────────────────────────────────────────────────────────────────────
// Write side (issue #93 Phase 2.6)
// ─────────────────────────────────────────────────────────────────────

export interface WriteKeychainOptions {
  endpoint: string;
  tokenPath?: string;
  bundle: KeychainBundle;
  timeoutMs?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export type KeychainWriter = (opts: WriteKeychainOptions) => Promise<boolean>;

/**
 * Push a freshly-refreshed bundle into the host Keychain so the
 * Claude Code app on the same host inherits it on its next read.
 *
 * Returns true on success, false on any failure (helper unavailable,
 * token missing, helper returned ok:false). Never throws — caller
 * (oauthRefresh.persistRefresh) treats this as best-effort
 * housekeeping; aide's own DB vault is the source of truth either
 * way.
 *
 * Same TCP/token plumbing as readKeychainBundle; both call the same
 * helper daemon.
 */
export const writeKeychainBundle: KeychainWriter = async (
  opts: WriteKeychainOptions,
): Promise<boolean> => {
  const log = opts.logger ?? { warn: (o: unknown, m?: string) =>
    process.stderr.write(JSON.stringify({ msg: m, ...((o as object) ?? {}) }) + "\n") };
  const timeoutMs = opts.timeoutMs ?? 3_000;

  const isTcp = opts.endpoint.includes(":") && !opts.endpoint.startsWith("/");
  let token: string | null = null;
  if (isTcp) {
    if (!opts.tokenPath) {
      log.warn(
        { endpoint: opts.endpoint },
        "keychain helper TCP endpoint requires tokenPath — disabled",
      );
      return false;
    }
    token = await readTokenCached(opts.tokenPath, log);
    if (!token) return false;
  }

  const payload = {
    op: "write" as const,
    ...(isTcp ? { auth: token } : {}),
    bundle: {
      access_token: opts.bundle.accessToken,
      refresh_token: opts.bundle.refreshToken,
      expires_at: opts.bundle.expiresAt.toISOString(),
    },
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let sock;
    if (isTcp) {
      const colon = opts.endpoint.lastIndexOf(":");
      const host = opts.endpoint.slice(0, colon);
      const port = parseInt(opts.endpoint.slice(colon + 1), 10);
      sock = connect(port, host);
    } else {
      sock = connect(opts.endpoint);
    }
    let buffer = "";

    const timer = setTimeout(() => {
      log.warn(
        { endpoint: opts.endpoint, timeoutMs },
        "keychain helper write timed out",
      );
      sock.destroy();
      settle(false);
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n");
    });

    sock.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      sock.end();
      clearTimeout(timer);

      let parsed: { ok?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(line);
      } catch {
        log.warn(
          { line: line.slice(0, 200) },
          "keychain helper write response not valid JSON",
        );
        settle(false);
        return;
      }
      if (parsed.ok !== true) {
        log.warn(
          { error: String(parsed.error ?? "unknown") },
          "keychain helper write returned error",
        );
        settle(false);
        return;
      }
      settle(true);
    });

    sock.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      log.warn(
        { err: err.message, endpoint: opts.endpoint },
        "keychain helper unavailable for write",
      );
      settle(false);
    });
  });
};
