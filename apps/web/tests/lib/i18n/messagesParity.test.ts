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
  "evaluator.rubrics.keyScope.saveFail",
  "evaluator.rubrics.keyScope.removedToast",
  "evaluator.rubrics.keyScope.requiresOptInHint",
  "evaluator.rubrics.keyScope.customBadge",
  "evaluator.rubrics.keyScope.usesFallbackHint",
  "apiKeys.evaluateAsProject.editRubric",
];

// All new keys required by the /device approval page (Task 13)
const DEVICE_APPROVAL_KEYS = [
  "deviceApproval.title", "deviceApproval.subtitle", "deviceApproval.codeLabel",
  "deviceApproval.codePlaceholder", "deviceApproval.lookupCta", "deviceApproval.deviceInfo",
  "deviceApproval.phishingWarning",
  "deviceApproval.consentHeading", "deviceApproval.consentBody", "deviceApproval.approve",
  "deviceApproval.deny", "deviceApproval.approved", "deviceApproval.denied",
  "deviceApproval.notFound", "deviceApproval.signInPrompt", "deviceApproval.signInCta",
];

// All new keys required by the org agent-config settings card (Task 14)
const AGENT_CONFIG_KEYS = [
  "devices.agentConfig.title",
  "devices.agentConfig.intervalLabel",
  "devices.agentConfig.intervalHint",
  "devices.agentConfig.save",
  "devices.agentConfig.saved",
  "devices.agentConfig.outOfRange",
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

describe("i18n catalog parity — device approval keys", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of DEVICE_APPROVAL_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});

describe("i18n catalog parity — agent config keys (Task 14)", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of AGENT_CONFIG_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});
