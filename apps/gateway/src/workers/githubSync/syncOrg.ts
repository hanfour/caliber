/**
 * One full org sync (PR1, spec 2026-07-15).
 * Decrypt PAT (salt = connection row id) → list repos ∩ allowlist →
 * per-repo pulls+issues with failure isolation → org Projects v2 →
 * persist status. Auth/rate-limit errors abort the loop (they would
 * fail every subsequent call); other errors skip just that repo.
 * Every stored error string passes through safeErrorMessage (redaction).
 */
import { eq } from "drizzle-orm";
import { githubConnections } from "@caliber/db";
import type { Database } from "@caliber/db";
import { decryptCredential, safeErrorMessage } from "@caliber/gateway-core";
import {
  createGithubClient,
  GithubAuthError,
  GithubRateLimitError,
} from "./githubClient.js";
import { syncRepoPulls } from "./syncPulls.js";
import { syncRepoIssues } from "./syncIssues.js";
import { syncOrgProjects } from "./syncProjects.js";

const MAX_ERROR_CHARS = 2000;

export interface SyncOrgResult {
  skippedReason?: "no_connection" | "disabled";
  repos: number;
  pulls: number;
  reviews: number;
  issues: number;
  projectItems: number;
  status: "ok" | "auth_error" | "rate_limited" | "sync_error";
  errors: string[];
  /**
   * GitHub's rate-limit reset time (epoch ms), captured when `status` is
   * "rate_limited" so the worker can delay the retry until the window
   * actually clears instead of burning fixed exponential backoff. `null`
   * when GitHub didn't send a parseable reset header; `undefined` when the
   * sync wasn't rate-limited at all.
   */
  rateLimitResetAtMs?: number | null;
}

const emptyResult = (skippedReason?: SyncOrgResult["skippedReason"]): SyncOrgResult => ({
  ...(skippedReason ? { skippedReason } : {}),
  repos: 0,
  pulls: 0,
  reviews: 0,
  issues: 0,
  projectItems: 0,
  status: "ok",
  errors: [],
});

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SyncOrgInput {
  db: Database;
  masterKeyHex: string;
  orgId: string;
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
}

export async function syncOrg(input: SyncOrgInput): Promise<SyncOrgResult> {
  const { db, masterKeyHex, orgId, fetchImpl } = input;

  const conn = (
    await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.orgId, orgId))
      .limit(1)
  )[0];
  if (!conn) return emptyResult("no_connection");
  if (!conn.deliveryEnabled) return emptyResult("disabled");

  let token: string;
  try {
    token = decryptCredential({
      masterKeyHex,
      accountId: conn.id,
      sealed: { nonce: conn.nonce, ciphertext: conn.ciphertext, authTag: conn.authTag },
    });
  } catch (err) {
    // A wrong/rotated CREDENTIAL_ENCRYPTION_KEY throws here, before the sync's
    // own try/catch. Without this branch the throw escapes past the status
    // update below and the row keeps a stale status='ok' — the operator sees a
    // healthy connection while nothing syncs (#270).
    const message = `credential decrypt failed: ${safeErrorMessage(err)}`;
    input.logger?.warn({ orgId, err: safeErrorMessage(err) }, "github sync: credential decrypt failed");
    await db
      .update(githubConnections)
      .set({
        status: "sync_error",
        lastSyncAt: new Date(),
        lastSyncError: message.slice(0, MAX_ERROR_CHARS),
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, conn.id));
    return { ...emptyResult(), status: "sync_error", errors: [message] };
  }
  const client = createGithubClient({ token, fetchImpl });

  let status: SyncOrgResult["status"] = "ok";
  // Tracks the same condition as `classify`'s return value (auth/rate-limit
  // hit). Kept as a plain boolean — rather than re-deriving it from `status`
  // — because TS's control-flow narrowing can't see through the `classify`
  // closure's reassignments across the labeled loop below, and would
  // otherwise over-narrow `status` back to "ok" after the loop.
  let aborted = false;
  let rateLimitResetAtMs: number | null | undefined;
  const errors: string[] = [];
  const totals = { repos: 0, pulls: 0, reviews: 0, issues: 0, projectItems: 0 };

  const classify = (err: unknown): boolean => {
    // Returns true when the loop must abort (error affects all further calls).
    if (err instanceof GithubAuthError) {
      status = "auth_error";
      aborted = true;
      return true;
    }
    if (err instanceof GithubRateLimitError) {
      status = "rate_limited";
      aborted = true;
      rateLimitResetAtMs = err.resetAtMs;
      return true;
    }
    if (status === "ok") status = "sync_error";
    return false;
  };

  try {
    const allRepos = await client.listRepoFullNames(conn.ownerLogin);
    const allowlist = conn.repoAllowlist as string[] | null;
    const repos = allowlist
      ? allRepos.filter((r) => allowlist.includes(r))
      : allRepos;
    totals.repos = repos.length;

    repoLoop: for (const repoFullName of repos) {
      for (const sync of [
        async () => {
          const r = await syncRepoPulls({ db, client, orgId, repoFullName });
          totals.pulls += r.pulls;
          totals.reviews += r.reviews;
        },
        async () => {
          const r = await syncRepoIssues({ db, client, orgId, repoFullName });
          totals.issues += r.issues;
        },
      ]) {
        try {
          await sync();
        } catch (err) {
          errors.push(`${repoFullName}: ${safeErrorMessage(err)}`);
          if (classify(err)) break repoLoop;
        }
      }
    }

    if (!aborted) {
      try {
        const r = await syncOrgProjects({
          db,
          client,
          orgId,
          ownerLogin: conn.ownerLogin,
        });
        totals.projectItems = r.projectItems;
      } catch (err) {
        errors.push(`projects: ${safeErrorMessage(err)}`);
        classify(err);
      }
    }
  } catch (err) {
    // Repo listing failed — nothing synced this round.
    errors.push(`repos: ${safeErrorMessage(err)}`);
    classify(err);
  }

  await db
    .update(githubConnections)
    .set({
      status,
      lastSyncAt: new Date(),
      lastSyncError:
        errors.length > 0 ? errors.join(" | ").slice(0, MAX_ERROR_CHARS) : null,
      updatedAt: new Date(),
    })
    .where(eq(githubConnections.id, conn.id));

  return { ...totals, status, errors, rateLimitResetAtMs };
}
