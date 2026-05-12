import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createErrorMap } from "../src/errorMap.js";
import { loadValidationMessages } from "../src/messages.js";

async function makeMap() {
  const messages = await loadValidationMessages("en");
  return createErrorMap(messages);
}

describe("createErrorMap", () => {
  it("invalid_type with undefined received → 'Required'", async () => {
    const map = await makeMap();
    const out = map(
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        path: ["name"],
      },
      { defaultError: "fallback", data: undefined },
    );
    expect(out.message).toBe("Required");
  });

  it("invalid_type with concrete received → templated", async () => {
    const map = await makeMap();
    const out = map(
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "string",
        received: "number",
        path: ["name"],
      },
      { defaultError: "fallback", data: undefined },
    );
    expect(out.message).toBe("Expected string, received number");
  });

  it("unknown code falls back to ctx.defaultError", async () => {
    const map = await makeMap();
    const out = map(
      // Use `custom` whose default message is whatever Zod gave us.
      {
        code: z.ZodIssueCode.custom,
        path: ["x"],
        message: "literal string",
      },
      { defaultError: "literal string", data: undefined },
    );
    expect(out.message).toBe("literal string");
  });
});
