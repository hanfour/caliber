import { describe, it, expect } from "vitest";
import { loadValidationMessages } from "../src/messages.js";

describe("loadValidationMessages", () => {
  it("returns the en catalogue", async () => {
    const messages = await loadValidationMessages("en");
    expect(messages.validation.codes.required).toBe("Required");
  });

  it("caches subsequent calls", async () => {
    const a = await loadValidationMessages("en");
    const b = await loadValidationMessages("en");
    expect(a).toBe(b);
  });
});
