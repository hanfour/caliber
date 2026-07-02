import { describe, it, expect } from "vitest";
import en from "../../../messages/en.json";
import zhTW from "../../../messages/zh-TW.json";
import zhCN from "../../../messages/zh-CN.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";

// All new keys required by PR6
const PR6_KEYS = [
  "evaluator.rubrics.keyScope.title",
  "evaluator.rubrics.keyScope.description",
  "evaluator.rubrics.keyScope.editButton",
  "evaluator.rubrics.keyScope.removeButton",
  "evaluator.rubrics.keyScope.confirmRemove",
  "evaluator.rubrics.keyScope.savedToast",
  "evaluator.rubrics.keyScope.removedToast",
  "evaluator.rubrics.keyScope.requiresOptInHint",
  "evaluator.rubrics.keyScope.customBadge",
  "evaluator.rubrics.keyScope.usesFallbackHint",
  "apiKeys.evaluateAsProject.editRubric",
];

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

describe("i18n catalog parity — PR6 keys", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of PR6_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});
