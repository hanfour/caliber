import { describe, it, expect } from "vitest";
import { platformForGatewayRoute } from "../../src/routes/surfacePlatform.js";

// These are the EXACT route patterns registered via `app.post(...)` in the
// gateway upstream route files. `req.routeOptions.url` equals the matched
// registration pattern verbatim, so every entry below must be a real key in
// ROUTE_PLATFORM — otherwise a non-pool (BYOK) key hitting it throws (→ 500).
//
//   /v1/messages                       -> messages.ts:241
//   /v1/chat/completions               -> chatCompletions.ts:65
//   /v1/responses                      -> responses.ts:472
//   /v1/responses/compact              -> responses.ts:473
//   /backend-api/codex/responses       -> codexResponses.ts:45 (bare)
//   /backend-api/codex/responses/*     -> codexResponses.ts:52 (find-my-way wildcard)
const cases: Array<[string, "anthropic" | "openai"]> = [
  ["/v1/messages", "anthropic"],
  ["/v1/chat/completions", "openai"],
  ["/v1/responses", "openai"],
  ["/v1/responses/compact", "openai"],
  ["/backend-api/codex/responses", "openai"],
  // Codex CLI subpaths match the wildcard registration; routeOptions.url is
  // the pattern with the trailing `*`, NOT the concrete request path.
  ["/backend-api/codex/responses/*", "openai"],
];

describe("platformForGatewayRoute", () => {
  it.each(cases)("maps %s -> %s", (url, expected) => {
    expect(platformForGatewayRoute({ routeOptions: { url } } as never)).toBe(expected);
  });

  it("maps the Codex wildcard pattern (not the request path) -> openai", () => {
    // A subpath hit like `/backend-api/codex/responses/v1` is matched by the
    // `/*` registration, so Fastify reports the wildcard as routeOptions.url.
    expect(
      platformForGatewayRoute({
        routeOptions: { url: "/backend-api/codex/responses/*" },
      } as never),
    ).toBe("openai");
  });

  it("throws on an unknown route", () => {
    expect(() => platformForGatewayRoute({ routeOptions: { url: "/v1/unknown" } } as never)).toThrow();
  });
});
