import { z } from "zod";

const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

const booleanUnion = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "string" ? v === "true" : v));

/**
 * Treat the empty string as `undefined` so docker-compose's
 * `${VAR:-}` soft-default (which evaluates to `""` when the operator
 * hasn't set the var) lets `z.*.default(...)` kick in. Without this,
 * `Number("")` coerces to `0` and bypasses the schema-level default —
 * which can either silently change behaviour (0 = disabled) or crash
 * boot when the schema demands `min(1)`.
 *
 * Wrap any optional-with-default schema that might receive an empty
 * string from the env via compose interpolation:
 *
 *   GATEWAY_X: emptyAsUndefined(z.coerce.number().int().min(1).default(10))
 */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    schema,
  );
}

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().url(),
    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 characters"),
    NEXTAUTH_URL: z.string().url(),
    /**
     * Auth.js v5 requires `trustHost` to accept requests on hosts other than
     * its compile-time allowlist. For self-hosted compose deploys (where the
     * operator owns NEXTAUTH_URL and the reverse proxy) the host is trusted
     * by definition, so default to `true`. Operators sitting behind an
     * untrusted edge can flip to `false` and rely on the AUTH_URL fallback.
     */
    AUTH_TRUST_HOST: booleanUnion.default(true),
    /**
     * OAuth provider creds are optional individually — operators can ship
     * Google-only, GitHub-only, or both. The runtime check in `buildProviders`
     * registers whichever pair is non-empty; `superRefine` below enforces that
     * at least one provider is configured so the sign-in page isn't dead.
     */
    GOOGLE_CLIENT_ID: emptyAsUndefined(z.string().min(1).optional()),
    GOOGLE_CLIENT_SECRET: emptyAsUndefined(z.string().min(1).optional()),
    GITHUB_CLIENT_ID: emptyAsUndefined(z.string().min(1).optional()),
    GITHUB_CLIENT_SECRET: emptyAsUndefined(z.string().min(1).optional()),
    BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email(),
    BOOTSTRAP_DEFAULT_ORG_SLUG: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
    BOOTSTRAP_DEFAULT_ORG_NAME: z.string().min(1),
    ENABLE_SWAGGER: booleanUnion.default(false),
    ENABLE_EVALUATOR: booleanUnion.default(false),
    /**
     * Plan 4C Phase 2 (v0.5.0). Server-wide kill switch for facet extraction.
     * When `false`, facet extraction never runs even for orgs that have
     * `llm_facet_enabled=true` set on their organizations row. When `true`,
     * the per-org `llm_facet_enabled` flag (and `llm_facet_model` value) gate
     * actual extraction. Off by default — requires opt-in at both env and
     * org levels.
     */
    ENABLE_FACET_EXTRACTION: booleanUnion.default(false),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    API_INTERNAL_URL: z.string().url().optional(),
    ENABLE_TEST_SEED: booleanUnion.default(false),
    TEST_SEED_TOKEN: z.string().min(32).optional(),

    // Gateway vars
    ENABLE_GATEWAY: booleanUnion.default(false),
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    GATEWAY_BASE_URL: z.string().url().optional(),
    GATEWAY_LOCAL_BASE_URL: z.string().url().default("http://localhost:3002"),
    REDIS_URL: z.string().url().optional(),
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .regex(
        HEX_64_REGEX,
        "CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)",
      )
      .optional(),
    API_KEY_HASH_PEPPER: z
      .string()
      .regex(
        HEX_64_REGEX,
        "API_KEY_HASH_PEPPER must be 64 hex characters (32 bytes)",
      )
      .optional(),
    UPSTREAM_ANTHROPIC_BASE_URL: emptyAsUndefined(
      z.string().url().default("https://api.anthropic.com"),
    ),
    UPSTREAM_OPENAI_BASE_URL: emptyAsUndefined(
      z.string().url().default("https://api.openai.com"),
    ),
    GATEWAY_MAX_ACCOUNT_SWITCHES: emptyAsUndefined(
      z.coerce.number().int().min(1).default(10),
    ),
    GATEWAY_MAX_BODY_BYTES: emptyAsUndefined(
      z.coerce.number().int().min(1024).default(10485760),
    ),
    GATEWAY_BUFFER_WINDOW_MS: emptyAsUndefined(
      z.coerce.number().int().min(0).default(500),
    ),
    GATEWAY_BUFFER_WINDOW_BYTES: emptyAsUndefined(
      z.coerce.number().int().min(0).default(2048),
    ),
    GATEWAY_REDIS_FAILURE_MODE: emptyAsUndefined(
      z.enum(["strict", "lenient"]).default("strict"),
    ),
    GATEWAY_IDEMPOTENCY_TTL_SEC: emptyAsUndefined(
      z.coerce.number().int().min(0).default(300),
    ),
    GATEWAY_TRUSTED_PROXIES: emptyAsUndefined(z.string().default("")),
    GATEWAY_OAUTH_REFRESH_LEAD_MIN: emptyAsUndefined(
      z.coerce.number().int().min(1).default(10),
    ),
    GATEWAY_OAUTH_MAX_FAIL: emptyAsUndefined(
      z.coerce.number().int().min(1).default(3),
    ),
    GATEWAY_QUEUE_SATURATE_THRESHOLD: emptyAsUndefined(
      z.coerce.number().int().min(1).default(5000),
    ),
    // Phase 3 #4-b — per-apiKey fixed-bucket rate limit. Per-minute
    // requests-per-key cap; first line of defence against a runaway
    // client burning through the quota_usd budget. 0 disables enforcement
    // entirely (still increments counters for observability when 0
    // would be confusing — currently we just skip the check).
    GATEWAY_APIKEY_RPM_LIMIT: emptyAsUndefined(
      z.coerce.number().int().min(0).default(600),
    ),
    // Phase 3 #2 — response-cache TTL. 0 disables caching. Cache scope is
    // (orgId, platform, request_body_bytes) → upstream response, only for
    // 200 + non-streaming + body < 64 KiB.  See
    // `apps/gateway/src/runtime/responseCache.ts` for the boundaries.
    GATEWAY_CACHE_TTL_SEC: emptyAsUndefined(
      z.coerce.number().int().min(0).default(0),
    ),
  })
  .superRefine((data, ctx) => {
    // OAuth provider validity: each pair must be set together (id + secret),
    // and at least one fully configured pair must exist. The half-set check
    // catches typos / missed copy-paste; without it, `buildProviders` would
    // silently drop the half-set provider and operators would scratch their
    // heads at a missing sign-in button.
    const googleId = !!data.GOOGLE_CLIENT_ID;
    const googleSecret = !!data.GOOGLE_CLIENT_SECRET;
    if (googleId !== googleSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: googleId ? ["GOOGLE_CLIENT_SECRET"] : ["GOOGLE_CLIENT_ID"],
        message:
          "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (or both empty to disable Google OAuth).",
      });
    }
    const githubId = !!data.GITHUB_CLIENT_ID;
    const githubSecret = !!data.GITHUB_CLIENT_SECRET;
    if (githubId !== githubSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: githubId ? ["GITHUB_CLIENT_SECRET"] : ["GITHUB_CLIENT_ID"],
        message:
          "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together (or both empty to disable GitHub OAuth).",
      });
    }
    const hasGoogle = googleId && googleSecret;
    const hasGitHub = githubId && githubSecret;
    if (!hasGoogle && !hasGitHub) {
      // Emit on both provider fields so the operator sees the error next to
      // whichever block they're trying to configure — the message itself
      // names both providers, so directionality of `path` isn't load-bearing.
      const message =
        "At least one OAuth provider must be configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET (or both).";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_CLIENT_ID"],
        message,
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GITHUB_CLIENT_ID"],
        message,
      });
    }

    if (!data.ENABLE_GATEWAY) {
      return;
    }

    const requiredGatewayFields = [
      "GATEWAY_BASE_URL",
      "REDIS_URL",
      "CREDENTIAL_ENCRYPTION_KEY",
      "API_KEY_HASH_PEPPER",
    ] as const;

    for (const field of requiredGatewayFields) {
      if (data[field] === undefined || data[field] === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required when ENABLE_GATEWAY is true`,
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(
  raw: Record<string, unknown> = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
