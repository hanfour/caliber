import { eq } from "drizzle-orm";
import { credentialVault } from "@caliber/db";
import type { Database } from "@caliber/db";
import { decryptCredential } from "@caliber/gateway-core";

export type ResolvedCredential =
  | { type: "api_key"; apiKey: string }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
      scope?: string;
    };

export class CredentialNotFoundError extends Error {
  constructor(public readonly accountId: string) {
    super(`No credential_vault row for account ${accountId}`);
    this.name = "CredentialNotFoundError";
  }
}

export class CredentialFormatError extends Error {
  constructor(
    message: string,
    public readonly accountId: string,
  ) {
    super(message);
    this.name = "CredentialFormatError";
  }
}

export interface ResolveCredentialOptions {
  masterKeyHex: string;
}

export async function resolveCredential(
  db: Database,
  accountId: string,
  opts: ResolveCredentialOptions,
): Promise<ResolvedCredential> {
  const row = await db
    .select({
      nonce: credentialVault.nonce,
      ciphertext: credentialVault.ciphertext,
      authTag: credentialVault.authTag,
    })
    .from(credentialVault)
    .where(eq(credentialVault.accountId, accountId))
    .limit(1)
    .then((r: Array<{ nonce: Buffer; ciphertext: Buffer; authTag: Buffer }>) => r[0]);

  if (!row) {
    throw new CredentialNotFoundError(accountId);
  }

  const plaintext = decryptCredential({
    masterKeyHex: opts.masterKeyHex,
    accountId,
    sealed: { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new CredentialFormatError(
      `credential plaintext is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      accountId,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CredentialFormatError("credential payload must be an object", accountId);
  }

  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "api_key") {
    if (typeof obj.api_key !== "string" || obj.api_key.length === 0) {
      throw new CredentialFormatError("api_key payload missing api_key string", accountId);
    }
    return { type: "api_key", apiKey: obj.api_key };
  }

  if (type === "oauth") {
    const { access_token, refresh_token, expires_at, scope } = obj;
    if (typeof access_token !== "string" || access_token.length === 0) {
      throw new CredentialFormatError("oauth payload missing access_token", accountId);
    }
    if (typeof refresh_token !== "string" || refresh_token.length === 0) {
      throw new CredentialFormatError("oauth payload missing refresh_token", accountId);
    }
    if (typeof expires_at !== "string") {
      throw new CredentialFormatError("oauth payload missing expires_at ISO string", accountId);
    }
    const expiresDate = new Date(expires_at);
    if (Number.isNaN(expiresDate.getTime())) {
      throw new CredentialFormatError(
        `oauth expires_at is not a valid ISO date: ${expires_at}`,
        accountId,
      );
    }
    return {
      type: "oauth",
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: expiresDate,
      ...(typeof scope === "string" ? { scope } : {}),
    };
  }

  throw new CredentialFormatError(`unknown credential type: ${String(type)}`, accountId);
}
