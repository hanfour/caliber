import { eq, and, isNull, lt } from "drizzle-orm";
import type { Redis } from "ioredis";
import { upstreamAccounts, credentialVault } from "@aide/db";
import type { Database } from "@aide/db";
import { keys } from "../redis/keys.js";
import {
  performRefresh,
  persistRefresh,
  recordFailure,
  readCredential,
  readVaultRotatedAt,
  type OAuthRefreshOptions,
} from "../runtime/oauthRefresh.js";

const CRON_INTERVAL_MS = 60_000;
const JITTER_MAX_MS = 10_000;
const LOCK_TTL_SEC = 30;
/** Hardcoded per design §5.2 — cron polls more aggressively than inline refresh. */
const LEAD_MINUTES_CRON = 10;
const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Keep in sync with runtime/oauthRefresh.ts. Override via env
// GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL.
const DEFAULT_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

export interface CronOptions extends Pick<
  OAuthRefreshOptions,
  "masterKeyHex" | "maxFail" | "tokenUrl" | "clientId"
> {
  /** Pino-style logger; receives info for refreshes/skips, error for failures. */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  jitter?: () => number;
}

export class OAuthRefreshCron {
  readonly #db: Database;
  readonly #redis: Redis;
  readonly #opts: CronOptions;
  #handle: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, redis: Redis, opts: CronOptions) {
    this.#db = db;
    this.#redis = redis;
    this.#opts = opts;
  }

  /** Start the cron with per-instance jitter (0..10s). Idempotent. */
  start(): void {
    if (this.#handle !== null) return;
    const jitterMs = (this.#opts.jitter ?? defaultJitter)();
    this.#handle = setTimeout(() => {
      void this.#tickAndSchedule();
    }, jitterMs);
  }

  /** Stop the cron. Idempotent. */
  stop(): void {
    if (this.#handle !== null) {
      clearTimeout(this.#handle);
      this.#handle = null;
    }
  }

  /**
   * Run a single cron tick — queries candidates and processes each.
   * Exposed for direct use in tests (no timer needed).
   */
  async runOnce(): Promise<{
    refreshed: number;
    skipped: number;
    failed: number;
  }> {
    const now = this.#opts.now ?? Date.now;
    const cutoff = new Date(now() + LEAD_MINUTES_CRON * 60 * 1000);

    const candidates = await this.#db
      .select({
        id: upstreamAccounts.id,
        failCount: upstreamAccounts.oauthRefreshFailCount,
        lastRunAt: upstreamAccounts.oauthRefreshLastRunAt,
        oauthExpiresAt: credentialVault.oauthExpiresAt,
      })
      .from(upstreamAccounts)
      .innerJoin(
        credentialVault,
        eq(credentialVault.accountId, upstreamAccounts.id),
      )
      .where(
        and(
          eq(upstreamAccounts.type, "oauth"),
          eq(upstreamAccounts.schedulable, true),
          isNull(upstreamAccounts.deletedAt),
          lt(credentialVault.oauthExpiresAt, cutoff),
        ),
      );

    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of candidates) {
      const result = await this.#processOne(row, now);
      if (result === "refreshed") refreshed++;
      else if (result === "skipped") skipped++;
      else failed++;
    }

    return { refreshed, skipped, failed };
  }

  async #processOne(
    row: {
      id: string;
      failCount: number;
      lastRunAt: Date | null;
      oauthExpiresAt: Date | null;
    },
    now: () => number,
  ): Promise<"refreshed" | "skipped" | "failed"> {
    // Exponential backoff: skip if too soon after last failure (2^fail_count * 60s)
    if (row.failCount > 0 && row.lastRunAt !== null) {
      const backoffMs = Math.pow(2, row.failCount) * 60 * 1000;
      if (row.lastRunAt.getTime() + backoffMs > now()) {
        this.#opts.logger?.info(
          { accountId: row.id, backoffMs },
          "oauth refresh cron: backing off",
        );
        return "skipped";
      }
    }

    const lockKey = keys.oauthRefresh(row.id);
    const acquired = await this.#redis.set(
      lockKey,
      "1",
      "EX",
      LOCK_TTL_SEC,
      "NX",
    );
    if (acquired !== "OK") {
      this.#opts.logger?.info(
        { accountId: row.id },
        "oauth refresh cron: lock held by another instance",
      );
      return "skipped";
    }

    try {
      const credential = await readCredential(
        this.#db,
        row.id,
        this.#opts.masterKeyHex,
      );
      if (credential.type !== "oauth") {
        // Defensive — shouldn't happen given the WHERE clause.
        return "skipped";
      }
      const prevRotatedAt = await readVaultRotatedAt(this.#db, row.id);
      const fresh = await performRefresh({
        currentRefreshToken: credential.refreshToken,
        tokenUrl: this.#opts.tokenUrl ?? DEFAULT_TOKEN_URL,
        clientId: this.#opts.clientId ?? DEFAULT_CLIENT_ID,
        now,
      });
      await persistRefresh(
        this.#db,
        row.id,
        fresh,
        this.#opts.masterKeyHex,
        now,
        prevRotatedAt,
      );
      this.#opts.logger?.info(
        { accountId: row.id, expiresAt: fresh.expiresAt },
        "oauth refresh cron: success",
      );
      return "refreshed";
    } catch (err) {
      await recordFailure(this.#db, row.id, err, this.#opts.maxFail, now);
      this.#opts.logger?.error(
        {
          accountId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "oauth refresh cron: failed",
      );
      return "failed";
    } finally {
      await this.#redis.del(lockKey).catch(() => {});
    }
  }

  async #tickAndSchedule(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.#opts.logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "oauth refresh cron: tick failed",
      );
    }
    if (this.#handle !== null) {
      this.#handle = setTimeout(() => {
        void this.#tickAndSchedule();
      }, CRON_INTERVAL_MS);
    }
  }
}

function defaultJitter(): number {
  return Math.floor(Math.random() * JITTER_MAX_MS);
}
