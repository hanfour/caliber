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

  describe("invalid_string variants", () => {
    it.each([
      ["email", "Invalid email address"],
      ["url", "Invalid URL"],
      ["uuid", "Invalid UUID"],
      ["regex", "Invalid format"],
      ["datetime", "Invalid date-time"],
      ["cuid", "Invalid CUID"],
    ])("%s → %s", async (validation, expected) => {
      const map = await makeMap();
      const out = map(
        {
          code: z.ZodIssueCode.invalid_string,
          validation: validation as
            | "email" | "url" | "uuid" | "regex" | "datetime" | "cuid",
          path: ["field"],
        },
        { defaultError: "x", data: undefined },
      );
      expect(out.message).toBe(expected);
    });
  });

  describe("too_small variants", () => {
    it.each([
      ["string", true, 3, "Must contain at least 3 character(s)"],
      ["string", false, 3, "Must contain more than 3 character(s)"],
      ["number", true, 5, "Must be greater than or equal to 5"],
      ["array", true, 2, "Must contain at least 2 item(s)"],
    ])("type=%s inclusive=%s minimum=%s", async (type, inclusive, minimum, expected) => {
      const map = await makeMap();
      const out = map(
        {
          code: z.ZodIssueCode.too_small,
          type: type as "string" | "number" | "array" | "date",
          minimum: minimum as number,
          inclusive: inclusive as boolean,
          exact: false,
          path: ["field"],
        },
        { defaultError: "x", data: undefined },
      );
      expect(out.message).toBe(expected);
    });
  });

  describe("too_big variants", () => {
    it("string inclusive max 255", async () => {
      const map = await makeMap();
      const out = map(
        {
          code: z.ZodIssueCode.too_big,
          type: "string",
          maximum: 255,
          inclusive: true,
          exact: false,
          path: ["name"],
        },
        { defaultError: "x", data: undefined },
      );
      expect(out.message).toBe("Must contain at most 255 character(s)");
    });
  });

  describe("invalid_enum_value", () => {
    it("formats options + received", async () => {
      const map = await makeMap();
      const out = map(
        {
          code: z.ZodIssueCode.invalid_enum_value,
          options: ["api_key", "oauth"],
          received: "magic_link",
          path: ["type"],
        },
        { defaultError: "x", data: undefined },
      );
      expect(out.message).toBe(
        "Expected one of api_key, oauth, received 'magic_link'",
      );
    });
  });

  describe("unrecognized_keys", () => {
    it("lists the offending keys", async () => {
      const map = await makeMap();
      const out = map(
        {
          code: z.ZodIssueCode.unrecognized_keys,
          keys: ["foo", "bar"],
          path: [],
        },
        { defaultError: "x", data: undefined },
      );
      expect(out.message).toBe("Unrecognised key(s) in object: foo, bar");
    });
  });
});
