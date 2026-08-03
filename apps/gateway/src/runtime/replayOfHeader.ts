// Reads the internal replay-marker header, but ONLY trusts it when the request
// authenticated with an eval key (keyPrefix "caliber-eval"). Eval keys' raw
// values exist only in gateway-internal Redis, so an external client cannot
// hold one — making the prefix a sufficient anti-forgery gate.
//
// Why this matters more than the eval pin it mirrors: a forged replay marker
// removes the request from `usage_logs_scored`, i.e. it lets a member hide
// their own traffic from scoring. Never widen the trust condition here.

export const REPLAY_OF_HEADER = "x-caliber-replay-of";
const EVAL_KEY_PREFIX = "caliber-eval";

export function replayOfHeader(req: {
  apiKey?: { keyPrefix?: string } | null;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  if (req.apiKey?.keyPrefix !== EVAL_KEY_PREFIX) return undefined;
  const raw = req.headers[REPLAY_OF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || undefined;
}
