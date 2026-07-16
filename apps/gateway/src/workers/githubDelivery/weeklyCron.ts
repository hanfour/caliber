/**
 * Weekly delivery-report cron (PR2). Fires Mondays 03:xx UTC (spec said
 * "server time"; UTC matches the evaluator cron convention). Hourly tick;
 * day-aligned rolling-30d windows make jobIds stable across same-Monday
 * repeat ticks, which dedup against completed hashes (plain add — the
 * regenerate path is manual-only).
 *
 * Excludes connections with status="auth_error" (revoked PAT orgs; parity
 * with githubSync/interval.ts:51).
 *
 * Interval skeleton (coalescing `scheduleTick` / epoch-guard / stopped-flag
 * / unref) copied verbatim from `../githubSync/interval.ts` (PR1, post-C1
 * fix) — only the tick body, interval constant, and the `clock` test seam
 * differ.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  accounts,
  githubConnections,
  organizationMembers,
  organizations,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import { enqueueGithubDelivery } from "./queue.js";
import type { QueueLike } from "../githubSync/queue.js";

export const GITHUB_DELIVERY_CRON_INTERVAL_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function shouldRunWeeklyDelivery(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 3;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface StartGithubDeliveryCronOptions {
  db: Database;
  queue: QueueLike;
  logger: LoggerLike;
  intervalMs?: number;
  /** Test seam; production uses `new Date()`. */
  clock?: () => Date;
}

export interface GithubDeliveryCronHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startGithubDeliveryCron(
  opts: StartGithubDeliveryCronOptions,
): GithubDeliveryCronHandle {
  const interval = opts.intervalMs ?? GITHUB_DELIVERY_CRON_INTERVAL_MS;
  let stopped = false;

  async function tick(): Promise<void> {
    const now = opts.clock?.() ?? new Date();
    if (!shouldRunWeeklyDelivery(now)) return;

    const members = await opts.db
      .selectDistinct({
        orgId: githubConnections.orgId,
        userId: organizationMembers.userId,
      })
      .from(githubConnections)
      .innerJoin(organizations, eq(githubConnections.orgId, organizations.id))
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.orgId, githubConnections.orgId),
      )
      .innerJoin(
        accounts,
        and(
          eq(accounts.userId, organizationMembers.userId),
          eq(accounts.provider, "github"),
        ),
      )
      .where(
        and(
          eq(githubConnections.deliveryEnabled, true),
          isNull(organizations.deletedAt),
          ne(githubConnections.status, "auth_error"),
        ),
      );

    const periodEnd = startOfUtcDay(now);
    const periodStart = new Date(periodEnd.getTime() - THIRTY_DAYS_MS);

    for (const m of members) {
      if (stopped) return;
      try {
        await enqueueGithubDelivery(opts.queue, {
          orgId: m.orgId,
          userId: m.userId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          periodType: "daily",
          triggeredBy: "cron",
        });
      } catch (err) {
        opts.logger.error({ err, orgId: m.orgId, userId: m.userId }, "github-delivery enqueue failed");
      }
    }
    if (members.length > 0) {
      opts.logger.info({ members: members.length }, "github-delivery weekly tick enqueued");
    }
  }

  // Tracks the in-flight tick so a manual `handle.tick()` call joins an
  // already-running pass (e.g. the run-at-start tick) instead of racing it
  // with a second, independent DB query + duplicate enqueues. Cleared back
  // to null once the pass settles so the next call starts a fresh one.
  let currentTick: Promise<void> | null = null;

  function scheduleTick(): Promise<void> {
    const settled = tick()
      .catch((err) => opts.logger.error({ err }, "github-delivery tick failed"))
      .finally(() => {
        if (currentTick === settled) currentTick = null;
      });
    currentTick = settled;
    return settled;
  }

  currentTick = scheduleTick(); // run once at start
  const timer = setInterval(() => {
    scheduleTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: () => currentTick ?? scheduleTick(),
  };
}
