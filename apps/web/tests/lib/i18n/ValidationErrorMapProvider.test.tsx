import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { z } from "zod";

// The shared setup (`apps/web/tests/setup.ts`) globally mocks `next-intl`
// so other component tests can run without a provider. This test needs
// the real `useLocale`/`NextIntlClientProvider` so locale-switching is
// observable — opt out of the global mock for this file only.
vi.unmock("next-intl");

import { NextIntlClientProvider } from "next-intl";
import { ValidationErrorMapProvider } from "@/lib/i18n/ValidationErrorMapProvider";
import enMessages from "../../../messages/en.json";
import zhTWMessages from "../../../messages/zh-TW.json";

function harness(locale: "en" | "zh-TW", messages: Record<string, unknown>) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ValidationErrorMapProvider>
        <div data-testid="kid" />
      </ValidationErrorMapProvider>
    </NextIntlClientProvider>,
  );
}

describe("ValidationErrorMapProvider", () => {
  it("renders children", () => {
    const { getByTestId } = harness("en", enMessages as Record<string, unknown>);
    expect(getByTestId("kid")).toBeInTheDocument();
  });

  it("installs an errorMap that translates to zh-TW", async () => {
    harness("zh-TW", zhTWMessages as Record<string, unknown>);
    await waitFor(() => {
      const result = z.string().min(1).safeParse("");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.message).toBe("至少需 1 個字元");
    });
  });

  it("installs an errorMap that translates to en when locale is en", async () => {
    harness("en", enMessages as Record<string, unknown>);
    await waitFor(() => {
      const result = z.string().email().safeParse("not-an-email");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.message).toBe("Invalid email address");
    });
  });
});
