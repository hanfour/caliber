import { describe, it, expect } from "vitest";
import { runWithLocale, currentLocale } from "../src/runtime.js";

describe("runtime", () => {
  it("returns DEFAULT_LOCALE outside any scope", () => {
    expect(currentLocale()).toBe("en");
  });

  it("returns the scoped locale inside runWithLocale", () => {
    const got = runWithLocale("zh-TW", () => currentLocale());
    expect(got).toBe("zh-TW");
  });

  it("preserves locale across awaits", async () => {
    const got = await runWithLocale("ja", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentLocale();
    });
    expect(got).toBe("ja");
  });

  it("nested scopes override outer", () => {
    const got = runWithLocale("ko", () =>
      runWithLocale("zh-CN", () => currentLocale()),
    );
    expect(got).toBe("zh-CN");
  });

  it("leaving a nested scope restores outer", () => {
    const result = runWithLocale("ko", () => {
      const inner = runWithLocale("zh-CN", () => currentLocale());
      const afterInner = currentLocale();
      return { inner, afterInner };
    });
    expect(result).toEqual({ inner: "zh-CN", afterInner: "ko" });
  });
});
