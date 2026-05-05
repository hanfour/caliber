import { describe, it, expect } from "vitest";
import { buildProviders, configuredProviderIds } from "../../src/providers";

describe("buildProviders", () => {
  it("returns Google + GitHub when both are configured", () => {
    const providers = buildProviders({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    expect(providers).toHaveLength(2);
  });

  it("skips Google when its creds are empty", () => {
    const providers = buildProviders({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    expect(providers).toHaveLength(1);
  });

  it("skips Google when its creds are undefined", () => {
    const providers = buildProviders({
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    expect(providers).toHaveLength(1);
  });

  it("skips GitHub when its creds are empty", () => {
    const providers = buildProviders({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    });
    expect(providers).toHaveLength(1);
  });

  it("returns empty when nothing is configured (env-schema layer is the gate)", () => {
    expect(buildProviders({})).toHaveLength(0);
  });

  it("skips a half-set provider (defense in depth — schema rejects this at boot)", () => {
    // The env schema's superRefine catches half-set pairs before this
    // function ever sees them in normal boot. This case pins the defensive
    // behavior for direct/unit-test callers that bypass the schema gate.
    const providers = buildProviders({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    expect(providers).toHaveLength(1);
  });
});

describe("configuredProviderIds", () => {
  it("reports both when both are configured", () => {
    expect(
      configuredProviderIds({
        GOOGLE_CLIENT_ID: "g",
        GOOGLE_CLIENT_SECRET: "gs",
        GITHUB_CLIENT_ID: "h",
        GITHUB_CLIENT_SECRET: "hs",
      }),
    ).toEqual(["google", "github"]);
  });

  it("reports github-only when google is blank", () => {
    expect(
      configuredProviderIds({
        GITHUB_CLIENT_ID: "h",
        GITHUB_CLIENT_SECRET: "hs",
      }),
    ).toEqual(["github"]);
  });

  it("reports google-only when github is blank", () => {
    expect(
      configuredProviderIds({
        GOOGLE_CLIENT_ID: "g",
        GOOGLE_CLIENT_SECRET: "gs",
      }),
    ).toEqual(["google"]);
  });

  it("reports empty when nothing is configured", () => {
    expect(configuredProviderIds({})).toEqual([]);
  });
});
