/**
 * 6-hourly github-sync scheduler (PR1). Same interval pattern as
 * evaluator/cron.ts (bodyPurge, billingAudit): run once at start,
 * then on a fixed interval; deterministic jobIds dedup overlaps.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { githubConnections, organizations } from "@caliber/db";
import type { Database } from "@caliber/db";
import { enqueueGithubSync, type QueueLike } from "./queue.js";

export const GITHUB_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface StartGithubSyncIntervalOptions {
  db: Database;
  queue: QueueLike;
  logger: LoggerLike;
  intervalMs?: number;
}

export interface GithubSyncCronHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startGithubSyncInterval(
  opts: StartGithubSyncIntervalOptions,
): GithubSyncCronHandle {
  const interval = opts.intervalMs ?? GITHUB_SYNC_INTERVAL_MS;
  let stopped = false;

  async function tick(): Promise<void> {
    const rows = await opts.db
      .select({ orgId: githubConnections.orgId })
      .from(githubConnections)
      .innerJoin(organizations, eq(githubConnections.orgId, organizations.id))
      .where(
        and(
          eq(githubConnections.deliveryEnabled, true),
          isNull(organizations.deletedAt),
          // Spec: "auth_error ... pauses the schedule" — a connection whose
          // PAT is rejected/revoked must stop being retried every tick until
          // the operator fixes it. Recovery already exists: setConnection
          // (githubDelivery.setConnection) resets status back to "ok" on a
          // successful re-probe, which re-admits the org here.
          ne(githubConnections.status, "auth_error"),
        ),
      );
    for (const row of rows) {
      if (stopped) return;
      try {
        await enqueueGithubSync(opts.queue, {
          orgId: row.orgId,
          triggeredBy: "interval",
        });
      } catch (err) {
        opts.logger.error({ err, orgId: row.orgId }, "github-sync enqueue failed");
      }
    }
    if (rows.length > 0) {
      opts.logger.info({ orgs: rows.length }, "github-sync tick enqueued");
    }
  }

  // Tracks the in-flight tick so a manual `handle.tick()` call joins an
  // already-running pass (e.g. the run-at-start tick) instead of racing it
  // with a second, independent DB query + duplicate enqueues. Cleared back
  // to null once the pass settles so the next call starts a fresh one.
  let currentTick: Promise<void> | null = null;

  function scheduleTick(): Promise<void> {
    const settled = tick()
      .catch((err) => opts.logger.error({ err }, "github-sync tick failed"))
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
