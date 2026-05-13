import { describe, it, expect } from "vitest";
import {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  pickFromAcceptLanguage,
  resolveLocale,
} from "../src/locales.js";

describe("locales", () => {
  it("ships five locales", () => {
    expect([...LOCALES]).toEqual(["en", "zh-TW", "zh-CN", "ja", "ko"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  describe("isLocale", () => {
    it("accepts shipped locales", () => {
      expect(isLocale("en")).toBe(true);
      expect(isLocale("zh-TW")).toBe(true);
    });
    it("rejects unknown / nullish", () => {
      expect(isLocale("fr")).toBe(false);
      expect(isLocale(null)).toBe(false);
      expect(isLocale(undefined)).toBe(false);
      expect(isLocale("")).toBe(false);
    });
  });

  describe("pickFromAcceptLanguage", () => {
    it("returns null when header is null/empty", () => {
      expect(pickFromAcceptLanguage(null)).toBeNull();
      expect(pickFromAcceptLanguage("")).toBeNull();
    });
    it("prefers exact match by priority", () => {
      expect(pickFromAcceptLanguage("zh-TW,zh;q=0.9,en;q=0.8")).toBe("zh-TW");
      expect(pickFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    });
    it("falls back to primary subtag", () => {
      // "zh" → first shipped locale starting with "zh-"
      expect(pickFromAcceptLanguage("zh;q=0.9")).toBe("zh-TW");
    });
    it("returns null for no match", () => {
      expect(pickFromAcceptLanguage("fr,de;q=0.9")).toBeNull();
    });
  });

  describe("resolveLocale", () => {
    it("cookie wins when valid", () => {
      expect(
        resolveLocale({ cookie: "ja", acceptLanguage: "zh-TW" }),
      ).toBe("ja");
    });
    it("falls through to Accept-Language when cookie invalid/missing", () => {
      expect(
        resolveLocale({ cookie: null, acceptLanguage: "ko,en;q=0.9" }),
      ).toBe("ko");
      expect(
        resolveLocale({ cookie: "xx", acceptLanguage: "zh-CN" }),
      ).toBe("zh-CN");
    });
    it("defaults when neither matches", () => {
      expect(
        resolveLocale({ cookie: null, acceptLanguage: null }),
      ).toBe("en");
      expect(
        resolveLocale({ cookie: null, acceptLanguage: "fr" }),
      ).toBe("en");
    });
  });
});
