import { expect, it } from "vitest";
import { Counter, Registry } from "prom-client";
import { counterValue } from "./scrapeMetrics.js";

it("sums only the matching-label series", async () => {
  const reg = new Registry();
  const c = new Counter({ name: "t_total", help: "h", labelNames: ["scope", "result"] as const, registers: [reg] });
  c.inc({ scope: "account", result: "ok" }, 3);
  c.inc({ scope: "account", result: "over_limit" }, 2);
  c.inc({ scope: "user", result: "ok" }, 5);
  expect(await counterValue(c, { scope: "account", result: "over_limit" })).toBe(2);
  expect(await counterValue(c, { scope: "account" })).toBe(5); // ok+over_limit
});

it("returns 0 for an unseen label combo (no throw)", async () => {
  const reg = new Registry();
  const c = new Counter({ name: "u_total", help: "h", labelNames: ["platform"] as const, registers: [reg] });
  expect(await counterValue(c, { platform: "anthropic" })).toBe(0);
});
