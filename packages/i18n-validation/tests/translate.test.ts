import { describe, it, expect } from "vitest";
import { translateValidationKey, formatValidationKey } from "../src/translate.js";
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

describe("formatValidationKey", () => {
  it("returns the bare key when params are absent", () => {
    expect(formatValidationKey("validation.custom.x.y")).toBe(
      "validation.custom.x.y",
    );
  });

  it("returns the bare key when params is an empty object", () => {
    expect(formatValidationKey("validation.custom.x.y", {})).toBe(
      "validation.custom.x.y",
    );
  });

  it("encodes params as a URL-encoded JSON suffix after '#'", () => {
    const out = formatValidationKey("validation.custom.x.y", { detail: "foo" });
    expect(out.startsWith("validation.custom.x.y#")).toBe(true);
    expect(decodeURIComponent(out.split("#")[1] ?? "")).toBe(
      '{"detail":"foo"}',
    );
  });

  it("preserves order and supports multiple params", () => {
    const out = formatValidationKey("validation.custom.x.y", {
      accountPlatform: "anthropic",
      groupPlatform: "openai",
    });
    expect(decodeURIComponent(out.split("#")[1] ?? "")).toBe(
      '{"accountPlatform":"anthropic","groupPlatform":"openai"}',
    );
  });
});

describe("translateValidationKey with params", () => {
  it("decodes params and substitutes {detail} (en)", async () => {
    const messages = await loadValidationMessages("en");
    const raw = formatValidationKey(
      "validation.custom.evaluator.rubricInvalidDefinition",
      { detail: "oops" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      "Invalid rubric definition: oops",
    );
  });

  it("roundtrips through zh-TW", async () => {
    const messages = await loadValidationMessages("zh-TW");
    const raw = formatValidationKey(
      "validation.custom.evaluator.rubricInvalidDefinition",
      { detail: "必須為有效的 JSON" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      "無效的 rubric 定義：必須為有效的 JSON",
    );
  });

  it("substitutes multiple placeholders", async () => {
    const messages = await loadValidationMessages("en");
    const raw = formatValidationKey(
      "validation.custom.accountGroups.accountPlatformMismatch",
      { accountPlatform: "anthropic", groupPlatform: "openai" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      'Account platform "anthropic" does not match group platform "openai"',
    );
  });

  it("falls back to bare template when payload JSON is malformed", async () => {
    const messages = await loadValidationMessages("en");
    // Uses an existing catalogue key (too_small.string.inclusive) rather than
    // the plan's rubricInvalidDefinition because that key is only added in
    // Task 4 — at this commit it would miss the catalogue and the test would
    // fail for the wrong reason (raw-key return, not malformed-payload return).
    expect(
      translateValidationKey(
        messages,
        "validation.codes.too_small.string.inclusive#not-json",
      ),
    ).toBe("Must contain at least {minimum} character(s)");
  });

  it("returns the full raw input when keyPart misses the catalogue", async () => {
    const messages = await loadValidationMessages("en");
    const raw =
      "validation.custom.does.not.exist#" +
      encodeURIComponent(JSON.stringify({ x: 1 }));
    expect(translateValidationKey(messages, raw)).toBe(raw);
  });
});
