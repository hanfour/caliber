import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { initTRPC } from "@trpc/server";
import {
  runWithLocale,
  setGlobalLocaleErrorMap,
} from "@caliber/i18n-validation";

// Lightweight integration: bypass Fastify and exercise the same code path
// (Zod input parse → global errorMap → AsyncLocalStorage lookup). We do
// not spin a real tRPC HTTP server because the unit-of-truth here is the
// errorMap → runWithLocale handshake; the full transport path is covered
// manually in PR-A smoke.

const t = initTRPC.context<{ locale: "en" | "zh-TW" | "zh-CN" | "ja" | "ko" }>().create();
const localeMw = t.middleware(({ ctx, next }) =>
  runWithLocale(ctx.locale, () => next()),
);
const router = t.router({
  echo: t.procedure
    .use(localeMw)
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => input.name),
});

beforeAll(async () => {
  await setGlobalLocaleErrorMap();
});

describe("tRPC locale-aware Zod errors", () => {
  it("zh-TW context yields 繁中 message", async () => {
    const caller = router.createCaller({ locale: "zh-TW" });
    await expect(caller.echo({ name: "" })).rejects.toMatchObject({
      message: expect.stringContaining("至少需 1 個字元"),
    });
  });

  it("ja context yields 日本語 message", async () => {
    const caller = router.createCaller({ locale: "ja" });
    await expect(caller.echo({ name: "" })).rejects.toMatchObject({
      message: expect.stringContaining("1 文字以上"),
    });
  });

  it("en context yields English message", async () => {
    const caller = router.createCaller({ locale: "en" });
    await expect(caller.echo({ name: "" })).rejects.toMatchObject({
      message: expect.stringContaining("at least 1 character"),
    });
  });
});
