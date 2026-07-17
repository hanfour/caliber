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

// All new keys required by continuous-section rendering + 108 pass line (Task 12)
const CONTINUOUS_SCORING_KEYS = [
  "evaluator.report.insufficientData",
  "evaluator.trendChart.passLine",
];

// All new keys required by the DeliveryDetail core component (PR4 Task 1)
const DELIVERY_KEYS = [
  "evaluator.delivery.title",
  "evaluator.delivery.loading",
  "evaluator.delivery.notEnabled",
  "evaluator.delivery.noReport",
  "evaluator.delivery.noIdentity",
  "evaluator.delivery.scoreLabel",
  "evaluator.delivery.adjustmentLabel",
  "evaluator.delivery.llmSkipped",
  "evaluator.delivery.generateBtn",
  "evaluator.delivery.generateQueued",
  "evaluator.delivery.windowMeta",
  "evaluator.delivery.section.throughput",
  "evaluator.delivery.section.collaboration",
  "evaluator.delivery.section.timeliness",
  "evaluator.delivery.metric.merged_pr_count",
  "evaluator.delivery.metric.issues_closed_count",
  "evaluator.delivery.metric.project_items_completed",
  "evaluator.delivery.metric.reviews_submitted",
  "evaluator.delivery.metric.distinct_prs_reviewed",
  "evaluator.delivery.metric.pr_lead_time_hours_median",
  "evaluator.delivery.metric.issue_resolution_days_median",
];

// All new keys required by DeliveryActivityList + DeliveryNarrative
// (PR4 Task 2)
const DELIVERY_ACTIVITY_NARRATIVE_KEYS = [
  "evaluator.delivery.narrativeTitle",
  "evaluator.delivery.evidenceTitle",
  "evaluator.delivery.activityTitle",
  "evaluator.delivery.pulls",
  "evaluator.delivery.issues",
  "evaluator.delivery.reviews",
  "evaluator.delivery.noActivity",
  "evaluator.delivery.noLinkedAccount",
];

// All new keys required by the member-detail tab strip (PR4 Task 3).
// `evaluator.delivery.title` is reused as the delivery tab label — only the
// new evaluation-tab label needs a key.
const DELIVERY_TAB_KEYS = ["evaluator.delivery.tabEvaluation"];

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

// The app renders message values as plain text (no Markdown renderer), so
// literal `**bold**` markers introduced during translation show up verbatim
// in the UI — this actually shipped in 4 locales' phishingWarning.
describe("i18n catalogs contain no literal Markdown bold markers", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  function collectStrings(node: unknown, path: string, out: Array<{ path: string; value: string }>): void {
    if (typeof node === "string") {
      out.push({ path, value: node });
      return;
    }
    if (node != null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        collectStrings(child, path ? `${path}.${key}` : key, out);
      }
    }
  }

  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has no "**" in any message value`, () => {
      const strings: Array<{ path: string; value: string }> = [];
      collectStrings(catalog, "", strings);
      const offenders = strings.filter((s) => s.value.includes("**"));
      expect(
        offenders.map((o) => `${o.path}: ${o.value}`),
        `literal Markdown bold in ${locale}`,
      ).toEqual([]);
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

describe("i18n catalog parity — continuous scoring keys (Task 12)", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of CONTINUOUS_SCORING_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});

describe("i18n catalog parity — DeliveryDetail keys (PR4 Task 1)", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of DELIVERY_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});

describe("i18n catalog parity — DeliveryActivityList + DeliveryNarrative keys (PR4 Task 2)", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of DELIVERY_ACTIVITY_NARRATIVE_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});

describe("i18n catalog parity — member detail tab strip keys (PR4 Task 3)", () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    en: en as unknown as Record<string, unknown>,
    "zh-TW": zhTW as unknown as Record<string, unknown>,
    "zh-CN": zhCN as unknown as Record<string, unknown>,
    ja: ja as unknown as Record<string, unknown>,
    ko: ko as unknown as Record<string, unknown>,
  };

  for (const key of DELIVERY_TAB_KEYS) {
    it(`"${key}" exists in all 5 catalogs`, () => {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const value = getByPath(catalog, key);
        expect(value, `Missing "${key}" in ${locale}`).toBeDefined();
        expect(typeof value, `"${key}" in ${locale} must be a string`).toBe("string");
      }
    });
  }
});
