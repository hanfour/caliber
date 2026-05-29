import { describe, it, expect } from "vitest";
import { encryptBodyRaw, decryptBodyRaw } from "../src/crypto/bodyCipher";
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
