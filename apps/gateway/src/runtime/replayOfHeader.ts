// Reads the internal replay-marker header, but ONLY trusts it when the request
// authenticated with an eval key (keyPrefix "caliber-eval"). Eval keys' raw
// values exist only in gateway-internal Redis, so an external client cannot
// hold one — making the prefix a sufficient anti-forgery gate.
//
// Why this matters more than the eval pin it mirrors: a forged replay marker
// removes the request from `usage_logs_scored`, i.e. it lets a member hide
// their own traffic from scoring. Never widen the trust condition here.

import { EVAL_KEY_PREFIX } from "./evalKeyPrefix.js";

export const REPLAY_OF_HEADER = "x-caliber-replay-of";

export function replayOfHeader(req: {
  apiKey?: { keyPrefix?: string } | null;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  if (req.apiKey?.keyPrefix !== EVAL_KEY_PREFIX) return undefined;
  const raw = req.headers[REPLAY_OF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Blank (empty OR whitespace-only) is treated the same as absent: a blank
  // value would still satisfy `!== null` in Postgres (`'' IS NULL` and
  // `'   ' IS NULL` are both false), so it would silently persist and pull
  // the row out of `usage_logs_scored` — the same scoring-evasion outcome as
  // a forged header, just reached via a degenerate value instead.
  return value?.trim() || undefined;
}
