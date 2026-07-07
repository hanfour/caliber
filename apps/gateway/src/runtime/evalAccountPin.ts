// Reads the internal eval account-pin header, but ONLY trusts it when the
// request authenticated with an eval key (keyPrefix "caliber-eval"). Eval keys'
// raw values exist only in gateway-internal Redis, so an external client
// cannot hold one — making the prefix a sufficient anti-forgery gate.

export const EVAL_PIN_HEADER = "x-caliber-eval-account-id";
const EVAL_KEY_PREFIX = "caliber-eval";

export function evalAccountPin(req: {
  apiKey?: { keyPrefix?: string } | null;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  if (req.apiKey?.keyPrefix !== EVAL_KEY_PREFIX) return undefined;
  const raw = req.headers[EVAL_PIN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || undefined;
}
