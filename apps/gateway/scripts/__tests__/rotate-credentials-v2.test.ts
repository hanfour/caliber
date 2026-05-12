/**
 * Unit tests for rotateAll (#121, Task 11).
 *
 * Validates the per-account dispatch logic of the v1→v2 migration script
 * without hitting a real DB or Anthropic. The function takes an injectable
 * refresh callback specifically so tests can drive it.
 *
 * Approach A: dispatch the fake `db` chain by reference equality on the
 * table object passed to `.from(...)` (upstreamAccounts vs credentialVault),
 * and intercept drizzle's `eq()` so the vault-row lookup can find the
 * correct row per accountId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { credentialVault, upstreamAccounts } from "@caliber/db";
import type { Database } from "@caliber/db";
import { encryptCredential } from "@caliber/gateway-core";

// Capture the rhs of the most recent eq() call so the fake db can
// dispatch SELECT/UPDATE on credentialVault by accountId.
const eqState: { lastAccountId: string | undefined } = {
  lastAccountId: undefined,
};

// Mock only eq() and isNull(); preserve every other drizzle-orm export
// (especially `sql`, which the schema files call at module load).
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (_col: unknown, val: unknown) => {
      eqState.lastAccountId = val as string;
      return { __mockEq: true, value: val };
    },
    isNull: (_col: unknown) => ({ __mockIsNull: true }),
  };
});

// Import the SUT after vi.mock so the mocked eq()/isNull() are in effect.
const { rotateAll } = await import("../rotate-credentials-v2.js");

const MASTER = "a".repeat(64);

/**
 * Produce a v1 sealed payload using the legacy `aide-gateway-credential-v1`
 * HKDF info string. The exported encryptCredential always writes v2, so we
 * need this helper to fabricate the kind of legacy ciphertext the rotation
 * script is supposed to read.
 */
function encryptCredentialV1(
  masterKeyHex: string,
  accountId: string,
  plaintext: string,
): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hkdfSync, createCipheriv, randomBytes } = require("crypto");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKeyHex, "hex"),
      Buffer.from(accountId, "utf8"),
      Buffer.from("aide-gateway-credential-v1", "utf8"),
      32,
    ),
  );
  const nonce: Buffer = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: ct, authTag: tag };
}

interface VaultBytes {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  cipherVersion: number;
}

interface FakeRow {
  accountId: string;
  type: string;
  vault: VaultBytes | null;
}

interface UpdateCapture {
  accountId: string;
  cipherVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  rotatedAt: Date;
}

function makeFakeDb(rows: FakeRow[]): {
  db: Database;
  updates: UpdateCapture[];
} {
  const updates: UpdateCapture[] = [];

  const db = {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === upstreamAccounts) {
          // Accounts query: db.select(...).from(upstreamAccounts).where(isNull(...))
          // is awaited directly — `.where()` must be thenable.
          const accountRows = rows.map((r) => ({
            id: r.accountId,
            type: r.type,
          }));
          return {
            where: (_pred: unknown) => Promise.resolve(accountRows),
          };
        }
        if (table === credentialVault) {
          // Vault query: .where(eq(...)).limit(1).then(r => r[0])
          return {
            where: (_pred: unknown) => ({
              limit: (_n: number) => ({
                then: <T>(cb: (r: VaultBytes[]) => T): Promise<T> => {
                  const target = eqState.lastAccountId;
                  const row = rows.find((x) => x.accountId === target);
                  const payload: VaultBytes[] = row?.vault ? [row.vault] : [];
                  return Promise.resolve(cb(payload));
                },
              }),
            }),
          };
        }
        throw new Error(
          `unexpected table in fake db.select().from(): ${String(table)}`,
        );
      },
    }),
    update: (table: unknown) => {
      if (table !== credentialVault) {
        throw new Error(
          `unexpected table in fake db.update(): ${String(table)}`,
        );
      }
      return {
        set: (vals: Omit<UpdateCapture, "accountId">) => ({
          where: async (_pred: unknown) => {
            const target = eqState.lastAccountId;
            if (!target) {
              throw new Error("update().where() invoked without eq() capture");
            }
            updates.push({ accountId: target, ...vals });
            return { rowCount: 1 };
          },
        }),
      };
    },
  } as unknown as Database;

  return { db, updates };
}

describe("rotateAll", () => {
  beforeEach(() => {
    eqState.lastAccountId = undefined;
  });

  it("dry-run on v1 api_key row: round-trip OK, no DB write, refresh NOT called", async () => {
    const accountId = "11111111-1111-1111-1111-111111111111";
    const sealed = encryptCredentialV1(
      MASTER,
      accountId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );
    const { db, updates } = makeFakeDb([
      {
        accountId,
        type: "api_key",
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: false,
      refresh,
    });

    expect(summary.apiKeyOk).toBe(1);
    expect(summary.apiKeyFail).toBe(0);
    expect(summary.alreadyV2).toBe(0);
    expect(updates).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("dry-run on v1 oauth row: logs intent, refresh NOT called", async () => {
    const accountId = "22222222-2222-2222-2222-222222222222";
    const sealed = encryptCredentialV1(
      MASTER,
      accountId,
      JSON.stringify({
        type: "oauth",
        access_token: "tok",
        refresh_token: "ref",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const { db, updates } = makeFakeDb([
      { accountId, type: "oauth", vault: { ...sealed, cipherVersion: 1 } },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: false,
      refresh,
    });

    expect(summary.oauthToRefresh).toBe(1);
    expect(summary.oauthRefreshed).toBe(0);
    expect(summary.oauthFailed).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("apply on v1 api_key row: UPDATE emitted with cipher_version=2", async () => {
    const accountId = "33333333-3333-3333-3333-333333333333";
    const sealed = encryptCredentialV1(
      MASTER,
      accountId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );
    const { db, updates } = makeFakeDb([
      {
        accountId,
        type: "api_key",
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.apiKeyOk).toBe(1);
    expect(updates).toHaveLength(1);
    const u = updates[0];
    if (!u) throw new Error("updates[0] missing");
    expect(u.accountId).toBe(accountId);
    expect(u.cipherVersion).toBe(2);
    expect(u.nonce).toBeInstanceOf(Buffer);
    expect(u.ciphertext).toBeInstanceOf(Buffer);
    expect(u.authTag).toBeInstanceOf(Buffer);
    expect(u.rotatedAt).toBeInstanceOf(Date);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("apply on v1 oauth row: refresh callback invoked exactly once with the account ID", async () => {
    const accountId = "44444444-4444-4444-4444-444444444444";
    const sealed = encryptCredentialV1(
      MASTER,
      accountId,
      JSON.stringify({
        type: "oauth",
        access_token: "tok",
        refresh_token: "ref",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const { db, updates } = makeFakeDb([
      { accountId, type: "oauth", vault: { ...sealed, cipherVersion: 1 } },
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.oauthRefreshed).toBe(1);
    expect(summary.oauthFailed).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(accountId);
    // refresh() is responsible for writing the new vault row, not rotateAll.
    expect(updates).toHaveLength(0);
  });

  it("already-v2 row is skipped on both dry-run and apply", async () => {
    const accountId = "55555555-5555-5555-5555-555555555555";
    const v2 = encryptCredential({
      masterKeyHex: MASTER,
      accountId,
      plaintext: JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    });
    const buildRows = (): FakeRow[] => [
      {
        accountId,
        type: "api_key",
        vault: {
          nonce: v2.nonce,
          ciphertext: v2.ciphertext,
          authTag: v2.authTag,
          cipherVersion: 2,
        },
      },
    ];

    // dry-run
    {
      const { db, updates } = makeFakeDb(buildRows());
      const refresh = vi.fn();
      const summary = await rotateAll({
        db,
        masterKeyHex: MASTER,
        apply: false,
        refresh,
      });
      expect(summary.alreadyV2).toBe(1);
      expect(summary.apiKeyOk).toBe(0);
      expect(updates).toHaveLength(0);
      expect(refresh).not.toHaveBeenCalled();
    }

    // apply
    {
      const { db, updates } = makeFakeDb(buildRows());
      const refresh = vi.fn();
      const summary = await rotateAll({
        db,
        masterKeyHex: MASTER,
        apply: true,
        refresh,
      });
      expect(summary.alreadyV2).toBe(1);
      expect(summary.apiKeyOk).toBe(0);
      expect(updates).toHaveLength(0);
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("one oauth refresh failure does not abort the batch — remaining rows still processed", async () => {
    const a = "66666666-6666-6666-6666-666666666666";
    const b = "77777777-7777-7777-7777-777777777777";
    const sealedA = encryptCredentialV1(
      MASTER,
      a,
      JSON.stringify({
        type: "oauth",
        access_token: "ta",
        refresh_token: "ra",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const sealedB = encryptCredentialV1(
      MASTER,
      b,
      JSON.stringify({
        type: "oauth",
        access_token: "tb",
        refresh_token: "rb",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const { db } = makeFakeDb([
      { accountId: a, type: "oauth", vault: { ...sealedA, cipherVersion: 1 } },
      { accountId: b, type: "oauth", vault: { ...sealedB, cipherVersion: 1 } },
    ]);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.oauthFailed).toBe(1);
    expect(summary.oauthRefreshed).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, a);
    expect(refresh).toHaveBeenNthCalledWith(2, b);
  });
});
