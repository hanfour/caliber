import { describe, it, expect } from "vitest";
import { deriveAccountStatus } from "@/components/accounts/status";

// Minimal row builder — only fields required by AccountStatusInput
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    schedulable: true,
    status: "active",
    rateLimitedAt: null,
    rateLimitResetAt: null,
    overloadUntil: null,
    tempUnschedulableUntil: null,
    tempUnschedulableReason: null,
    expiresAt: null,
    errorMessage: null,
    ...overrides,
  } as Parameters<typeof deriveAccountStatus>[0];
}

describe("deriveAccountStatus credential_invalid", () => {
  it("returns credential_invalid when reason is api_key_invalid_credential", () => {
    const r = makeRow({
      schedulable: true,
      status: "error",
      errorMessage: "upstream rejected credential (401)",
      tempUnschedulableUntil: new Date(Date.now() + 3_600_000).toISOString(),
      tempUnschedulableReason: "api_key_invalid_credential",
    });
    expect(deriveAccountStatus(r)).toBe("credential_invalid");
  });

  it("returns paused (not credential_invalid) when reason is something else", () => {
    const r = makeRow({
      tempUnschedulableUntil: new Date(Date.now() + 3_600_000).toISOString(),
      tempUnschedulableReason: "some_other_reason",
    });
    expect(deriveAccountStatus(r)).toBe("paused");
  });

  it("returns credential_invalid ranked above paused", () => {
    // Both tempUnschedulableUntil (future) AND credential reason set:
    // credential_invalid should win over generic paused
    const r = makeRow({
      tempUnschedulableUntil: new Date(Date.now() + 3_600_000).toISOString(),
      tempUnschedulableReason: "api_key_invalid_credential",
    });
    expect(deriveAccountStatus(r)).toBe("credential_invalid");
  });
});
