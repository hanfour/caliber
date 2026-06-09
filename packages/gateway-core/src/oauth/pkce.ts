import { createHash, randomBytes } from "node:crypto";

export function generatePKCEVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
