import { describe, it, expect } from "vitest";
import {
  encryptBodyRaw,
  decryptBodyRaw,
  CURRENT_BODY_CIPHER_VERSION,
} from "../src/crypto/bodyCipher";
import { randomBytes } from "crypto";

const FIXED_MASTER = "a".repeat(64);
const FIXED_REQUEST = "req-test-1";
const FIXED_PLAINTEXT = "hello body v1";

// v1 fixture — pre-recorded ciphertext for (FIXED_MASTER, FIXED_REQUEST,
// FIXED_PLAINTEXT) under HKDF info "aide-gateway-body-v1".
// Regenerate by running the body-cipher node script in plan Task 3 Step 1.
const V1_FIXTURE = {
  nonce: Buffer.from("070707070707070707070707", "hex"),
  ciphertext: Buffer.from("9b521c6bb683a0986f0eaba4e1", "hex"),
  authTag: Buffer.from("ab37b63e55c9bf871794d7a9f75003f4", "hex"),
};

describe("bodyCipher", () => {
  it("CURRENT version is 2", () => {
    expect(CURRENT_BODY_CIPHER_VERSION).toBe(2);
  });

  it("encrypt + decrypt v2 round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(sealed.version).toBe(2);
    const recovered = decryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      sealed,
      version: 2,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("decrypts pre-recorded v1 fixture with version: 1", () => {
    const recovered = decryptBodyRaw({
      masterKeyHex: FIXED_MASTER,
      requestId: FIXED_REQUEST,
      sealed: V1_FIXTURE,
      version: 1,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("v1 ciphertext with version: 2 throws (auth tag mismatch)", () => {
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: FIXED_MASTER,
        requestId: FIXED_REQUEST,
        sealed: V1_FIXTURE,
        version: 2,
      }),
    ).toThrow();
  });

  it("v2 ciphertext with version: 1 throws", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: masterKey,
        requestId: FIXED_REQUEST,
        sealed,
        version: 1,
      }),
    ).toThrow();
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
        version: 2,
      }),
    ).toThrow();
  });

  // Master-key validation and tampered-ciphertext detection are covered
  // once via credentialCipher.test.ts because that behavior lives in the
  // shared aesGcmHkdf primitive, not in the body-cipher dispatch layer.
});
