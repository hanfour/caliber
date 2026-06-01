// Plan 5A PR 9d (review M1) — shared boilerplate for the "acquire
// slot → resolve credential → maybe-refresh OAuth → run callback →
// release slot" pattern that every route's `runFailover.attempt`
// callback repeats verbatim.
//
// Each route's failover callback shrinks from ~30 lines to ~10:
//   attempt: async (account) =>
//     withSlotAndCredential(app, opts, account, requestId, async (credential) => {
//       const upstream = await callUpstreamX({ …, credential });
//       // route-specific result handling
//       return result;
//     })
//
// Centralising it here makes the slot/credential lifecycle a single
// place to fix bugs (e.g. if we ever add a request-scope tag for
// metrics) instead of having to remember 4+ near-identical attempt
// bodies in messages.ts / chatCompletions.ts / responses.ts.

import type { FastifyInstance } from "fastify";
import type { ServerEnv } from "@caliber/config";
import type { SelectedAccount } from "./selectAccount.js";
import { resolveCredential, type ResolvedCredential } from "./resolveCredential.js";
import { maybeRefreshOAuth } from "./oauthRefresh.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";

/** Safety-net expiry: slot key expires in Redis even if release is missed. */
const SLOT_DURATION_MS = 60_000;

export interface WithSlotAndCredentialOptions {
  env: ServerEnv;
}

/**
 * Acquire a per-account concurrency slot, resolve the credential
 * vault entry, refresh the OAuth token if it's nearing expiry, then
 * run `fn(credential)`.  Releases the slot in `finally` (errors
 * swallowed since the slot expires on its own within
 * `SLOT_DURATION_MS`).
 *
 * Thrown errors from `fn` propagate up so the surrounding
 * `runFailover` loop can classify them.  An at-capacity slot throws
 * `{ status: 503, message: "account_at_capacity" }` — the failover
 * classifier maps this to `switch_account` so the next account in the
 * pool gets a chance.
 */
export async function withSlotAndCredential<T>(
  app: FastifyInstance,
  opts: WithSlotAndCredentialOptions,
  account: SelectedAccount,
  requestId: string,
  fn: (credential: ResolvedCredential) => Promise<T>,
): Promise<T> {
  const acquired = await acquireSlot(
    app.redis,
    "account",
    account.id,
    requestId,
    account.concurrency,
    SLOT_DURATION_MS,
    app.gwMetrics.slotAcquireTotal,
  );
  if (!acquired) {
    throw { status: 503, message: "account_at_capacity" };
  }
  try {
    let credential = await resolveCredential(app.db, account.id, {
      masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
    });
    if (credential.type === "oauth") {
      credential = await maybeRefreshOAuth(
        app.db,
        app.redis,
        account.id,
        credential,
        {
          masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
          leadMinutes: opts.env.GATEWAY_OAUTH_REFRESH_LEAD_MIN,
          maxFail: opts.env.GATEWAY_OAUTH_MAX_FAIL,
          tokenUrl: opts.env.GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL,
          keychainEndpoint: opts.env.GATEWAY_KEYCHAIN_HELPER_ENDPOINT,
          keychainTokenPath: opts.env.GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH,
          logger: app.log,
          oauthRefreshDeadMetric: app.gwMetrics.oauthRefreshDeadTotal,
        },
      );
    }
    return await fn(credential);
  } finally {
    await releaseSlot(app.redis, "account", account.id, requestId).catch(
      () => {
        // Slot expires on its own within SLOT_DURATION_MS.
      },
    );
  }
}
