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

// 32 bytes (43-char base64url) to match Claude Code. claude.ai's OAuth grant
// step rejects shorter states with "Invalid request format" (confirmed via
// live OAuth 2026-06-09: a 16-byte state failed, 32-byte succeeded). 32 bytes
// is also fine for the OpenAI flow, which treats state as opaque.
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}
