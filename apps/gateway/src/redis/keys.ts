// Single source of truth for Redis key shapes. ioredis client (Task 4.1) prepends
// `aide:gw:` via keyPrefix; these helpers return the suffix only.
// All shapes match design Section 4.1 + Plan 5A §8.2.
export const keys = {
  slots: (scope: "user" | "account", id: string) => `slots:${scope}:${id}`,
  wait: (userId: string) => `wait:user:${userId}`,
  idem: (requestId: string) => `idem:${requestId}`,
  sticky: (orgId: string, sessionId: string) => `sticky:${orgId}:${sessionId}`,
  // Plan 5A §8.2 Layer 1 — `previous_response_id` sticky (TTL 1h)
  stickyResp: (groupId: string, previousResponseId: string) =>
    `sticky:resp:${groupId}:${previousResponseId}`,
  // Plan 5A §8.2 Layer 2 — `session_hash` sticky (TTL 30m)
  stickySession: (groupId: string, sessionHash: string) =>
    `sticky:session:${groupId}:${sessionHash}`,
  state: (accountId: string) => `state:account:${accountId}`,
  oauthRefresh: (accountId: string) => `oauth-refresh:${accountId}`,
  // Issue #92 sub-task 4 — per-account post-failure lock. SET on
  // recordFailure with TTL = backoff seconds; checked at top of
  // maybeRefreshOAuth. While present, the inline path skips refresh
  // and treats the credential as "still fresh enough" (sends current
  // access_token through; if upstream 401s, it'll be classified as
  // a real failure rather than as a stale-token symptom).
  oauthBackoff: (accountId: string) => `oauth-backoff:${accountId}`,
  // Phase 3 #4-b — fixed-bucket sliding-window rate limit on per-apiKey
  // request rate. `minuteBucket = floor(Date.now() / 60_000)`; the key
  // implicitly rotates every 60s, so we don't need cleanup.
  rlApiKey: (apiKeyId: string, minuteBucket: number) =>
    `rl:apikey:${apiKeyId}:${minuteBucket}`,
} as const;
