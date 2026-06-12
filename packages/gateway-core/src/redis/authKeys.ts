// Pure suffix builders for the api_key credential-health counters. Both the
// gateway and the api Redis clients prepend `caliber:gw:`, so these return
// the suffix only. Lives in gateway-core because apps/api depends on
// @caliber/gateway-core (not on apps/gateway).
export const authFailKey = (accountId: string): string => `authfail:${accountId}`;
export const authGraceKey = (accountId: string): string => `authgrace:${accountId}`;
