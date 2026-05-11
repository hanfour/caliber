/**
 * Rotation script for HKDF v1 → v2 cipher migration (#121).
 *
 * Default mode is dry-run: scans upstream_accounts + credential_vault,
 * verifies api_key rows round-trip cleanly through decrypt-v1 →
 * encrypt-v2 → decrypt-v2, and lists what would happen on --apply.
 *
 * --apply writes the new v2 sealed bytes back to credential_vault for
 * api_key accounts; for oauth accounts, it invokes the injected refresh
 * function (which in main() reads the v1 credential, calls the Anthropic
 * token endpoint, and persists the new bundle through persistRefresh —
 * which encrypts with cipher_version=2).
 *
 * Idempotent — re-running skips rows already at cipher_version=2.
 *
 * Usage:
 *   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts
 *   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts --apply
 */

import { eq, isNull } from "drizzle-orm";
import {
  credentialVault,
  upstreamAccounts,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import {
  decryptCredential,
  encryptCredential,
} from "@caliber/gateway-core";

export interface RunSummary {
  apply: boolean;
  candidates: number;
  alreadyV2: number;
  apiKeyOk: number;
  apiKeyFail: number;
  oauthToRefresh: number;
  oauthRefreshed: number;
  oauthFailed: number;
}

export interface RotateAllOptions {
  db: Database;
  masterKeyHex: string;
  apply: boolean;
  /** Injectable so tests can avoid hitting Anthropic. */
  refresh: (accountId: string) => Promise<void>;
}

export async function rotateAll(opts: RotateAllOptions): Promise<RunSummary> {
  const { db, masterKeyHex, apply, refresh } = opts;

  console.log(
    `[rotate] mode = ${apply ? "APPLY (will write to DB)" : "DRY-RUN (read-only)"}`,
  );

  const accounts = await db
    .select({ id: upstreamAccounts.id, type: upstreamAccounts.type })
    .from(upstreamAccounts)
    .where(isNull(upstreamAccounts.deletedAt));

  const summary: RunSummary = {
    apply,
    candidates: accounts.length,
    alreadyV2: 0,
    apiKeyOk: 0,
    apiKeyFail: 0,
    oauthToRefresh: 0,
    oauthRefreshed: 0,
    oauthFailed: 0,
  };

  for (const acct of accounts) {
    const vaultRow = await db
      .select({
        nonce: credentialVault.nonce,
        ciphertext: credentialVault.ciphertext,
        authTag: credentialVault.authTag,
        cipherVersion: credentialVault.cipherVersion,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id))
      .limit(1)
      .then((r) => r[0]);

    if (!vaultRow) {
      console.warn(
        `[rotate] account ${acct.id} (${acct.type}): NO VAULT ROW — skipping`,
      );
      continue;
    }

    if (vaultRow.cipherVersion === 2) {
      console.log(
        `[rotate] skip already-v2 account ${acct.id} (${acct.type})`,
      );
      summary.alreadyV2++;
      continue;
    }

    if (acct.type === "api_key") {
      try {
        const plaintext = decryptCredential({
          masterKeyHex,
          accountId: acct.id,
          sealed: {
            nonce: vaultRow.nonce,
            ciphertext: vaultRow.ciphertext,
            authTag: vaultRow.authTag,
          },
          version: 1,
        });
        const reSealed = encryptCredential({
          masterKeyHex,
          accountId: acct.id,
          plaintext,
        });
        const verifyRoundTrip = decryptCredential({
          masterKeyHex,
          accountId: acct.id,
          sealed: {
            nonce: reSealed.nonce,
            ciphertext: reSealed.ciphertext,
            authTag: reSealed.authTag,
          },
          version: 2,
        });
        if (verifyRoundTrip !== plaintext) {
          throw new Error("round-trip plaintext mismatch");
        }

        if (apply) {
          await db
            .update(credentialVault)
            .set({
              nonce: reSealed.nonce,
              ciphertext: reSealed.ciphertext,
              authTag: reSealed.authTag,
              cipherVersion: reSealed.version,
              rotatedAt: new Date(),
            })
            .where(eq(credentialVault.accountId, acct.id));
          console.log(`[rotate] APPLIED api_key account ${acct.id}`);
        } else {
          console.log(
            `[DRY] would rotate api_key account ${acct.id}: round-trip OK`,
          );
        }
        summary.apiKeyOk++;
      } catch (err) {
        console.error(
          `[rotate] FAIL api_key account ${acct.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.apiKeyFail++;
      }
      continue;
    }

    if (acct.type === "oauth") {
      if (!apply) {
        console.log(`[DRY] would force refresh oauth account ${acct.id}`);
        summary.oauthToRefresh++;
        continue;
      }
      try {
        await refresh(acct.id);
        console.log(`[rotate] REFRESHED oauth account ${acct.id}`);
        summary.oauthRefreshed++;
      } catch (err) {
        console.error(
          `[rotate] FAIL oauth refresh ${acct.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.oauthFailed++;
      }
      continue;
    }

    console.warn(`[rotate] unknown type for account ${acct.id}: ${acct.type}`);
  }

  console.log("[rotate] summary:", JSON.stringify(summary, null, 2));

  return summary;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const masterKeyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!masterKeyHex || !/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    console.error(
      "CREDENTIAL_ENCRYPTION_KEY env var missing or not 32 bytes hex",
    );
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL env var missing");
    process.exit(2);
  }

  // Construct DB. Repo convention is createDb(url) → { db, pool }.
  const { createDb } = await import("@caliber/db");
  const { db, pool } = createDb(databaseUrl);

  // Compose OAuth refresh from existing primitives. The repo doesn't
  // expose a single `refreshOAuthCredential({ force })` helper; instead
  // maybeRefreshOAuth gates on expiry. For rotation we *always* want a
  // fresh token regardless of expiry, so we drive the steps directly:
  //
  //   1. readCredential — decrypts the current vault row (handles v1).
  //   2. readVaultRotatedAt — CAS baseline for persistRefresh.
  //   3. performRefresh — calls Anthropic token endpoint.
  //   4. persistRefresh — writes the new bundle. This calls
  //      encryptCredential under the hood, which produces v2 sealed
  //      bytes and stamps cipher_version=2 on the row.
  //
  // No Redis lock — rotation is an offline ops procedure, operator is
  // expected to gate concurrent runs themselves.
  const {
    readCredential,
    readVaultRotatedAt,
    performRefresh,
    persistRefresh,
    DEFAULT_TOKEN_URL,
    DEFAULT_CLIENT_ID,
  } = await import("../src/runtime/oauthRefresh.js");

  const tokenUrl =
    process.env.GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL ?? DEFAULT_TOKEN_URL;
  const clientId =
    process.env.GATEWAY_ANTHROPIC_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;

  const refresh = async (accountId: string): Promise<void> => {
    const current = await readCredential(db, accountId, masterKeyHex);
    if (current.type !== "oauth") {
      throw new Error(`expected oauth credential for ${accountId}`);
    }
    const prevRotatedAt = await readVaultRotatedAt(db, accountId);
    const fresh = await performRefresh({
      currentRefreshToken: current.refreshToken,
      tokenUrl,
      clientId,
    });
    await persistRefresh(
      db,
      accountId,
      fresh,
      masterKeyHex,
      Date.now,
      prevRotatedAt,
    );
  };

  try {
    const summary = await rotateAll({ db, masterKeyHex, apply, refresh });

    // Dry-run exit code: non-zero if any api_key round-trip failed
    if (!apply && summary.apiKeyFail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

// Only run main() when executed as a script, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[rotate] fatal:", err);
    process.exit(1);
  });
}
