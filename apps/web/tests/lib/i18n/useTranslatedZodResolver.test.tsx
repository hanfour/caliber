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
import { loadValidationMessages, formatValidationKey } from "@caliber/i18n-validation";
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

// Schema that mirrors the RubricEditor.tsx:58 superRefine shape — emits a
// custom issue whose message carries a runtime-interpolated `{detail}`.
const rubricSchema = z.object({
  definitionJson: z.string().superRefine((_val, ctx) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: formatValidationKey(
        "validation.custom.evaluator.rubricInvalidDefinition",
        { detail: "必須為有效的 JSON" },
      ),
    });
  }),
});
type RubricValues = z.infer<typeof rubricSchema>;

interface RubricProbeProps {
  onError: (msg: string | undefined) => void;
  onSubmitRef: { current: (() => void) | null };
}

function RubricProbe({ onError, onSubmitRef }: RubricProbeProps) {
  const resolver = useTranslatedZodResolver(rubricSchema);
  const { handleSubmit } = useForm<RubricValues>({
    resolver,
    defaultValues: { definitionJson: "" },
  });
  const submit = useRef<() => void>(() => undefined);
  submit.current = () => {
    void handleSubmit(
      () => undefined,
      (errs) => {
        onError(errs.definitionJson?.message as string | undefined);
      },
    )();
  };
  useEffect(() => {
    onSubmitRef.current = () => submit.current?.();
  }, [onSubmitRef]);
  return <span data-testid="rubric-ready">1</span>;
}

// Schema with a z.array() field — exercises the array-recursion branch in
// translateNode (previously skipped, leaving validation.* keys untranslated
// in useFieldArray / array-of-objects error trees).
const arraySchema = z.object({
  items: z.array(
    z.object({
      label: z.string().min(1, "validation.custom.shared.nameRequired"),
    }),
  ),
});
type ArrayValues = z.infer<typeof arraySchema>;

interface ArrayProbeProps {
  onError: (msg: string | undefined) => void;
  onSubmitRef: { current: (() => void) | null };
}

function ArrayProbe({ onError, onSubmitRef }: ArrayProbeProps) {
  const resolver = useTranslatedZodResolver(arraySchema);
  const { handleSubmit } = useForm<ArrayValues>({
    resolver,
    defaultValues: { items: [{ label: "" }] },
  });
  const submit = useRef<() => void>(() => undefined);
  submit.current = () => {
    void handleSubmit(
      () => undefined,
      (errs) => {
        // errs.items is an array; grab the first element's label message.
        const first = errs.items?.[0];
        onError(first?.label?.message as string | undefined);
      },
    )();
  };
  useEffect(() => {
    onSubmitRef.current = () => submit.current?.();
  }, [onSubmitRef]);
  return <span data-testid="array-ready">1</span>;
}

describe("useTranslatedZodResolver with z.array()", () => {
  it("translates validation.* keys nested inside an array error node", async () => {
    await loadValidationMessages("en");
    let captured: string | undefined;
    const onSubmitRef: { current: (() => void) | null } = { current: null };
    render(
      <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
        <ArrayProbe
          onError={(m) => {
            captured = m;
          }}
          onSubmitRef={onSubmitRef}
        />
      </NextIntlClientProvider>,
    );
    await pollUntilTranslated(() => captured, onSubmitRef, "Name is required");
  });
});

describe("useTranslatedZodResolver with runtime params", () => {
  it("translates a key carrying {detail} into zh-TW with interpolation", async () => {
    await loadValidationMessages("zh-TW");
    let captured: string | undefined;
    const onSubmitRef: { current: (() => void) | null } = { current: null };
    render(
      <NextIntlClientProvider
        locale="zh-TW"
        messages={zhTWMessages as Record<string, unknown>}
      >
        <RubricProbe
          onError={(m) => {
            captured = m;
          }}
          onSubmitRef={onSubmitRef}
        />
      </NextIntlClientProvider>,
    );
    await pollUntilTranslated(
      () => captured,
      onSubmitRef,
      "無效的 rubric 定義：必須為有效的 JSON",
    );
  });
});
