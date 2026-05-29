import { describe, it, expect } from "vitest";
import { encryptCredential, decryptCredential } from "../src/crypto/credentialCipher";
import { randomBytes } from "crypto";

const FIXED_ACCOUNT = "00000000-0000-0000-0000-000000000001";
const FIXED_PLAINTEXT = JSON.stringify({ api_key: "sk-ant-test" });

describe("credentialCipher", () => {
  it("encrypt + decrypt round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    const recovered = decryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      sealed,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("fails to decrypt with wrong accountId (HKDF salt mismatch)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "a",
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: "b",
        sealed,
      }),
    ).toThrow();
  });

  it("validates master key format (32 bytes hex)", () => {
    expect(() =>
      encryptCredential({
        masterKeyHex: "too-short",
        accountId: FIXED_ACCOUNT,
        plaintext: FIXED_PLAINTEXT,
      }),
    ).toThrow();
  });

  it("throws when ciphertext is tampered", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    const tampered = {
      ...sealed,
      ciphertext: Buffer.concat([
        sealed.ciphertext.subarray(0, sealed.ciphertext.length - 1),
        Buffer.from([0xff]),
      ]),
    };
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: FIXED_ACCOUNT,
        sealed: tampered,
      }),
    ).toThrow();
  });
});
