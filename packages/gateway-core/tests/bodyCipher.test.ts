import { describe, it, expect } from "vitest";
import {
  encryptBodyRaw,
  decryptBodyRaw,
  packSealedBody,
  unpackSealedBody,
  decryptStoredBody,
} from "../src/crypto/bodyCipher";
import { randomBytes } from "crypto";

const FIXED_REQUEST = "req-test-1";
const FIXED_PLAINTEXT = "hello body";

describe("bodyCipher", () => {
  it("encrypt + decrypt round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    const recovered = decryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      sealed,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("fails to decrypt with wrong requestId (HKDF salt mismatch)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: "req-a",
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: masterKey,
        requestId: "req-b",
        sealed,
      }),
    ).toThrow();
  });

  // Master-key validation and tampered-ciphertext detection are covered
  // once via credentialCipher.test.ts because that behavior lives in the
  // shared aesGcmHkdf primitive, not in the body-cipher layer.
});

// The stored framing is a cross-app STORAGE FORMAT: apps/gateway writes
// `request_bodies.*_sealed`, apps/api's replay comparison reads it back. The
// byte layout is asserted literally here so a "harmless" reordering breaks a
// test instead of breaking every historical row's readability.
describe("bodyCipher stored framing", () => {
  it("packs as nonce(12) || ciphertext || authTag(16)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    const stored = packSealedBody(sealed);

    expect(stored.length).toBe(
      sealed.nonce.length + sealed.ciphertext.length + sealed.authTag.length,
    );
    expect(stored.subarray(0, 12).equals(sealed.nonce)).toBe(true);
    expect(stored.subarray(stored.length - 16).equals(sealed.authTag)).toBe(
      true,
    );
    expect(
      stored.subarray(12, stored.length - 16).equals(sealed.ciphertext),
    ).toBe(true);
  });

  it("unpack reverses pack", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    const round = unpackSealedBody(packSealedBody(sealed));
    expect(round.nonce.equals(sealed.nonce)).toBe(true);
    expect(round.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(round.authTag.equals(sealed.authTag)).toBe(true);
  });

  it("decryptStoredBody round-trips a packed blob", () => {
    const masterKey = randomBytes(32).toString("hex");
    const stored = packSealedBody(
      encryptBodyRaw({
        masterKeyHex: masterKey,
        requestId: FIXED_REQUEST,
        plaintext: FIXED_PLAINTEXT,
      }),
    );
    expect(
      decryptStoredBody({
        masterKeyHex: masterKey,
        requestId: FIXED_REQUEST,
        stored,
      }),
    ).toBe(FIXED_PLAINTEXT);
  });

  it("rejects a blob too short to contain a nonce and a tag", () => {
    expect(() => unpackSealedBody(Buffer.alloc(27))).toThrow(
      /sealed buffer too small/,
    );
  });
});
