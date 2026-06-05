import { describe, it, expect } from "vitest";
import { platformForGatewayRoute } from "../../src/routes/surfacePlatform.js";

const cases: Array<[string, "anthropic" | "openai"]> = [
  ["/v1/messages", "anthropic"],
  ["/v1/chat/completions", "openai"],
  ["/v1/responses", "openai"],
  ["/v1/responses/compact", "openai"],
  ["/backend-api/codex/responses", "openai"],
];

describe("platformForGatewayRoute", () => {
  it.each(cases)("maps %s -> %s", (url, expected) => {
    expect(platformForGatewayRoute({ routeOptions: { url } } as never)).toBe(expected);
  });
  it("throws on an unknown route", () => {
    expect(() => platformForGatewayRoute({ routeOptions: { url: "/v1/unknown" } } as never)).toThrow();
  });
});
