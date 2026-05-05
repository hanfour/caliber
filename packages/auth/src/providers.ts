import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import type { Provider } from "next-auth/providers";

export interface ProviderEnv {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
}

/**
 * A provider is "configured" only when BOTH halves of its credential pair
 * are non-empty. Single source of truth for `buildProviders` /
 * `configuredProviderIds` so adding a third provider only touches one rule.
 */
function isConfigured(id?: string, secret?: string): boolean {
  return !!id && !!secret;
}

/**
 * Build the OAuth provider list from env. Operators can ship Google-only,
 * GitHub-only, or both. The env schema enforces "at least one provider" and
 * "no half-set pairs" upstream, so this function never legitimately returns
 * an empty array during boot, but defensive callers should still verify.
 */
export function buildProviders(env: ProviderEnv): Provider[] {
  const providers: Provider[] = [];
  if (isConfigured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) {
    providers.push(
      Google({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }
  if (isConfigured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) {
    providers.push(
      GitHub({
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }
  return providers;
}

/**
 * Inspect-only helper for the sign-in UI: returns which provider buttons
 * should be rendered based on the same rule as `buildProviders`.
 */
export function configuredProviderIds(env: ProviderEnv): Array<"google" | "github"> {
  const ids: Array<"google" | "github"> = [];
  if (isConfigured(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) ids.push("google");
  if (isConfigured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) ids.push("github");
  return ids;
}
