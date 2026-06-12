import type { UpstreamError, FailoverAction } from './types.js'

const SAME_ACCOUNT_BACKOFF_MS = 500
const OVERLOAD_COOLDOWN_SEC = 60
const TRANSIENT_COOLDOWN_SEC = 30

export function classifyUpstreamError(err: UpstreamError): FailoverAction {
  if ('kind' in err) {
    if (err.kind === 'connection' || err.kind === 'timeout') {
      return { kind: 'retry_same_account', backoffMs: SAME_ACCOUNT_BACKOFF_MS }
    }
  }
  if (!('status' in err)) {
    return { kind: 'fatal', statusCode: 500, reason: 'unknown_error' }
  }
  const now = new Date()
  const { status, retryAfter } = err
  if (status === 401 || status === 403) {
    return {
      kind: 'switch_account',
      reason: 'auth_invalid',
    }
  }
  if (status === 429) {
    const resetAt = retryAfter
      ? new Date(now.getTime() + retryAfter * 1000)
      : new Date(now.getTime() + 60_000)
    return {
      kind: 'switch_account',
      stateUpdate: { rateLimitedAt: now, rateLimitResetAt: resetAt },
      reason: 'rate_limited',
    }
  }
  if (status === 529) {
    return {
      kind: 'switch_account',
      stateUpdate: { overloadUntil: new Date(now.getTime() + OVERLOAD_COOLDOWN_SEC * 1000) },
      reason: 'overloaded',
    }
  }
  if (status >= 500 && status < 600) {
    return {
      kind: 'switch_account',
      stateUpdate: {
        tempUnschedulableUntil: new Date(now.getTime() + TRANSIENT_COOLDOWN_SEC * 1000),
        tempUnschedulableReason: `upstream_${status}`,
      },
      reason: `transient_${status}`,
    }
  }
  // 4xx client errors (400, 422, etc.)
  return { kind: 'fatal', statusCode: status, reason: 'client_error' }
}
