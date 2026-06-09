import type { Redis } from "ioredis";

// Per-IP auth-failure brute-force throttle (spec §4.2). Two keys:
//   auth-fail:<ip>        — sliding count of recent auth failures (window TTL)
//   auth-fail-block:<ip>  — present => the IP is blocked (block TTL)
// Both live under the ioredis keyPrefix (caliber:gw:) configured on the client.

export interface AuthThrottleConfig {
  max: number; // failures within the window that trigger a block; 0 disables
  windowSec: number;
  blockSec: number;
}

const failKey = (ip: string) => `auth-fail:${ip}`;
const blockKey = (ip: string) => `auth-fail-block:${ip}`;

export interface BlockedState {
  blocked: boolean;
  retryAfterSec: number;
}

// Is this IP currently blocked? retryAfterSec = remaining block TTL.
export async function checkIpBlocked(
  redis: Redis,
  ip: string,
): Promise<BlockedState> {
  const ttl = await redis.ttl(blockKey(ip));
  if (ttl > 0) return { blocked: true, retryAfterSec: ttl };
  return { blocked: false, retryAfterSec: 0 };
}

export interface RecordResult {
  justBlocked: boolean;
  retryAfterSec: number;
}

// Record one auth failure for this IP. When the count crosses `max`, set the
// block key (blockSec TTL) and report justBlocked. max=0 disables entirely.
export async function recordAuthFailure(
  redis: Redis,
  ip: string,
  cfg: AuthThrottleConfig,
): Promise<RecordResult> {
  if (cfg.max <= 0) return { justBlocked: false, retryAfterSec: 0 };
  const k = failKey(ip);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, cfg.windowSec);
  if (count >= cfg.max) {
    await redis.set(blockKey(ip), "1", "EX", cfg.blockSec);
    return { justBlocked: true, retryAfterSec: cfg.blockSec };
  }
  return { justBlocked: false, retryAfterSec: 0 };
}
