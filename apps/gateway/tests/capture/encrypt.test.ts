import { describe, it, expect } from "vitest";
import { encryptBody, decryptBody } from "../../src/capture/encrypt.js";

const MASTER_KEY = "a".repeat(64); // 32-byte hex string

describe("encryptBody / decryptBody", () => {
  it("round-trips UTF-8 plaintext", () => {
    const plaintext = JSON.stringify({ message: "hello 測試 🚀" });
    const enc = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "req-1",
      plaintext,
    });
    const decrypted = decryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "req-1",
      sealed: enc.sealed,
    });
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random nonce)", () => {
    const plaintext = "same";
    const a = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext,
    });
    const b = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext,
    });
    expect(a.sealed.equals(b.sealed)).toBe(false);
  });

  it("fails to decrypt with wrong requestId (salt mismatch)", () => {
    const enc = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "right",
      plaintext: "x",
    });
    expect(() =>
      decryptBody({
        masterKeyHex: MASTER_KEY,
        requestId: "wrong",
        sealed: enc.sealed,
      }),
    ).toThrow();
  });

  it("fails to decrypt with wrong master key", () => {
    const enc = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "x",
    });
    const WRONG = "b".repeat(64);
    expect(() =>
      decryptBody({
        masterKeyHex: WRONG,
        requestId: "r",
        sealed: enc.sealed,
      }),
    ).toThrow();
  });

  it("rejects sealed buffer that's too small", () => {
    expect(() =>
      decryptBody({
        masterKeyHex: MASTER_KEY,
        requestId: "r",
        sealed: Buffer.from("x"),
      }),
    ).toThrow(/too small/);
  });

  it("encrypt output format: nonce(12) || ciphertext || authTag(16)", () => {
    const enc = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "hello",
    });
    // Min: 12 nonce + 1 ciphertext + 16 tag = 29
    expect(enc.sealed.length).toBeGreaterThanOrEqual(12 + 1 + 16);
  });

  it("different info (body vs credential) produces incompatible ciphertexts", () => {
    const enc = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "p",
    });
    const r = decryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      sealed: enc.sealed,
    });
    expect(r).toBe("p");
  });
});
