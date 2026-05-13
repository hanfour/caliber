import { describe, it, expect, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

// `apps/web/tests/setup.ts` globally mocks `next-intl` for component tests.
// We need the real `useLocale` so the hook sees the active locale —
// opt out of the global mock for this file only.
vi.unmock("next-intl");

import { NextIntlClientProvider } from "next-intl";
import { useTranslatedZodResolver } from "@/lib/i18n/useTranslatedZodResolver";
import { loadValidationMessages } from "@caliber/i18n-validation";
import enMessages from "../../../messages/en.json";
import zhTWMessages from "../../../messages/zh-TW.json";

// Single-field schema that uses a `validation.*` key for its message — the
// exact bug shape: Zod's makeIssue() bypasses the global errorMap because
// .min(1, key) supplies an explicit `message`.
const schema = z.object({
  name: z.string().min(1, "validation.custom.shared.nameRequired"),
});
type Values = z.infer<typeof schema>;

interface ProbeProps {
  onError: (msg: string | undefined) => void;
  onSubmitRef: { current: (() => void) | null };
}

function Probe({ onError, onSubmitRef }: ProbeProps) {
  const resolver = useTranslatedZodResolver(schema);
  const { handleSubmit } = useForm<Values>({
    resolver,
    defaultValues: { name: "" },
  });
  const submit = useRef<() => void>(() => undefined);
  submit.current = () => {
    void handleSubmit(
      () => undefined,
      (errs) => {
        onError(errs.name?.message as string | undefined);
      },
    )();
  };
  useEffect(() => {
    onSubmitRef.current = () => submit.current?.();
  }, [onSubmitRef]);
  return <span data-testid="ready">1</span>;
}

function harness(
  locale: "en" | "zh-TW",
  messages: Record<string, unknown>,
  onError: (msg: string | undefined) => void,
) {
  const onSubmitRef: { current: (() => void) | null } = { current: null };
  const result = render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <Probe onError={onError} onSubmitRef={onSubmitRef} />
    </NextIntlClientProvider>,
  );
  return { ...result, onSubmitRef };
}

// loadValidationMessages caches inside the package, so calling it from the
// test pre-warms the cache the hook sees. Without this the hook's useEffect
// would still be in-flight at submit time and the resolver would short-circuit
// to the bare zodResolver (raw key surfaces — the very bug we're fixing).
async function pollUntilTranslated(
  getCaptured: () => string | undefined,
  onSubmitRef: { current: (() => void) | null },
  expected: string,
): Promise<void> {
  await waitFor(
    async () => {
      await act(async () => {
        onSubmitRef.current?.();
        // Yield to let RHF's async resolver settle.
        await Promise.resolve();
      });
      expect(getCaptured()).toBe(expected);
    },
    { timeout: 2000, interval: 50 },
  );
}

describe("useTranslatedZodResolver", () => {
  it("translates a validation.* key into the en string", async () => {
    await loadValidationMessages("en");
    let captured: string | undefined;
    const { onSubmitRef } = harness(
      "en",
      enMessages as Record<string, unknown>,
      (m) => {
        captured = m;
      },
    );
    await pollUntilTranslated(() => captured, onSubmitRef, "Name is required");
  });

  it("translates the same key into zh-TW under that locale", async () => {
    await loadValidationMessages("zh-TW");
    let captured: string | undefined;
    const { onSubmitRef } = harness(
      "zh-TW",
      zhTWMessages as Record<string, unknown>,
      (m) => {
        captured = m;
      },
    );
    await pollUntilTranslated(() => captured, onSubmitRef, "名稱為必填");
  });
});
