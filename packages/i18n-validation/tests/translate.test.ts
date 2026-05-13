import { describe, it, expect } from "vitest";
import { translateValidationKey } from "../src/translate.js";
import { loadValidationMessages } from "../src/messages.js";

describe("translateValidationKey", () => {
  it("resolves a known key", async () => {
    const messages = await loadValidationMessages("en");
    // shared.nameRequired was added in B4
    expect(
      translateValidationKey(messages, "validation.custom.shared.nameRequired"),
    ).toBe("Name is required");
  });

  it("returns raw input for non-validation prefix", async () => {
    const messages = await loadValidationMessages("en");
    expect(translateValidationKey(messages, "literal english")).toBe(
      "literal english",
    );
  });

  it("returns raw key on miss", async () => {
    const messages = await loadValidationMessages("en");
    expect(
      translateValidationKey(messages, "validation.custom.does.not.exist"),
    ).toBe("validation.custom.does.not.exist");
  });

  it("resolves zh-TW key", async () => {
    const messages = await loadValidationMessages("zh-TW");
    expect(
      translateValidationKey(messages, "validation.custom.shared.nameRequired"),
    ).toBe("名稱為必填");
  });

  it("returns raw key when path resolves to non-string (object)", async () => {
    const messages = await loadValidationMessages("en");
    // `validation.codes.invalid_string` is an object, not a string leaf.
    expect(
      translateValidationKey(messages, "validation.codes.invalid_string"),
    ).toBe("validation.codes.invalid_string");
  });
});
