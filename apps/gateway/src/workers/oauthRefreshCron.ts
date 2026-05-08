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

/**
 * Adaptive cron tick rates (issue #92 sub-task 3).
 *
 * The original 60s fixed interval polls the DB and (potentially)
 * anthropic regardless of how far away the next account expiry is.
 * In a typical deployment with 1 account whose token lasts ~24h, that's
 * 1380 redundant ticks per day. Worse: when the cron has nothing to
 * do but logs every tick, operators get noise that makes real failures
 * harder to spot.
 *
 * The new policy: peek at the next-expiring account's oauthExpiresAt
 * before scheduling the next tick. If we're more than 30min away
 * from the lead window, sleep up to MAX_TICK_MS. Otherwise stay at
 * MIN_TICK_MS so we don't miss a refresh by undersleeping.
 */
const MIN_TICK_MS = 60_000; // when work is imminent
const MAX_TICK_MS = 600_000; // when nothing is due for a long time
const FAR_AWAY_THRESHOLD_MS = 30 * 60 * 1000;
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
    // Issue #92 sub-task 4: respect the inline post-failure backoff
    // lock too. Otherwise cron would keep retrying while inline path
    // is correctly waiting (especially on 429 where failCount stays 0
    // and the failCount-based backoff below never engages).
    const inBackoff = await this.#redis.exists(keys.oauthBackoff(row.id));
    if (inBackoff === 1) {
      this.#opts.logger?.info(
        { accountId: row.id },
        "oauth refresh cron: post-failure backoff lock held — skipping",
      );
      return "skipped";
    }

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
      await recordFailure(
        this.#db,
        this.#redis,
        row.id,
        err,
        this.#opts.maxFail,
        now,
      );
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

  /**
   * Compute the next tick delay (issue #92 sub-task 3). Reads the
   * earliest oauthExpiresAt across schedulable oauth accounts and
   * returns:
   * - MIN_TICK_MS if any account is already inside / past the lead window
   * - MIN_TICK_MS if the next expiry is within FAR_AWAY_THRESHOLD_MS
   *   of the lead window (so we don't oversleep through it)
   * - MAX_TICK_MS otherwise (idle-safe interval)
   *
   * Always with [0, JITTER_MAX_MS) jitter applied. Returns MIN_TICK_MS
   * + jitter on any DB error (defensive — better to over-tick than
   * miss a refresh).
   */
  async #computeNextTickMs(now: () => number): Promise<number> {
    const jitter = (this.#opts.jitter ?? defaultJitter)();
    try {
      const [minRow] = await this.#db
        .select({ oauthExpiresAt: credentialVault.oauthExpiresAt })
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
          ),
        )
        .orderBy(credentialVault.oauthExpiresAt)
        .limit(1);

      if (!minRow?.oauthExpiresAt) {
        // No schedulable oauth accounts at all — sleep long.
        return MAX_TICK_MS + jitter;
      }

      const leadWindowStart =
        minRow.oauthExpiresAt.getTime() - LEAD_MINUTES_CRON * 60 * 1000;
      const msUntilLeadWindow = leadWindowStart - now();
      if (msUntilLeadWindow <= 0) {
        // Already inside the lead window — tick min.
        return MIN_TICK_MS + jitter;
      }
      if (msUntilLeadWindow <= FAR_AWAY_THRESHOLD_MS) {
        // Approaching the lead window — tick min so we don't miss it.
        return MIN_TICK_MS + jitter;
      }
      // Far away — sleep long, but cap at the time-to-lead-window so
      // we wake up exactly at FAR_AWAY_THRESHOLD_MS before the window
      // (modulo jitter).
      const sleepMs = Math.min(
        MAX_TICK_MS,
        msUntilLeadWindow - FAR_AWAY_THRESHOLD_MS,
      );
      return Math.max(MIN_TICK_MS, sleepMs) + jitter;
    } catch (err) {
      this.#opts.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "oauth refresh cron: failed to compute next tick — defaulting to MIN",
      );
      return MIN_TICK_MS + jitter;
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
      const nextMs = await this.#computeNextTickMs(this.#opts.now ?? Date.now);
      this.#handle = setTimeout(() => {
        void this.#tickAndSchedule();
      }, nextMs);
    }
  }
}

function defaultJitter(): number {
  return Math.floor(Math.random() * JITTER_MAX_MS);
}
