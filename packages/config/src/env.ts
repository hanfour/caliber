import { z } from "zod";

const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

const booleanUnion = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "string" ? v === "true" : v));

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().url(),
    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 characters"),
    NEXTAUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
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
    UPSTREAM_ANTHROPIC_BASE_URL: z
      .string()
      .url()
      .default("https://api.anthropic.com"),
    UPSTREAM_OPENAI_BASE_URL: z
      .string()
      .url()
      .default("https://api.openai.com"),
    GATEWAY_MAX_ACCOUNT_SWITCHES: z.coerce.number().int().min(1).default(10),
    GATEWAY_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(10485760),
    GATEWAY_BUFFER_WINDOW_MS: z.coerce.number().int().min(0).default(500),
    GATEWAY_BUFFER_WINDOW_BYTES: z.coerce.number().int().min(0).default(2048),
    GATEWAY_REDIS_FAILURE_MODE: z.enum(["strict", "lenient"]).default("strict"),
    GATEWAY_IDEMPOTENCY_TTL_SEC: z.coerce.number().int().min(0).default(300),
    GATEWAY_TRUSTED_PROXIES: z.string().default(""),
    GATEWAY_OAUTH_REFRESH_LEAD_MIN: z.coerce.number().int().min(1).default(10),
    GATEWAY_OAUTH_MAX_FAIL: z.coerce.number().int().min(1).default(3),
    GATEWAY_QUEUE_SATURATE_THRESHOLD: z.coerce
      .number()
      .int()
      .min(1)
      .default(5000),
    // Phase 3 #4-b — per-apiKey fixed-bucket rate limit. Per-minute
    // requests-per-key cap; first line of defence against a runaway
    // client burning through the quota_usd budget. 0 disables enforcement
    // entirely (still increments counters for observability when 0
    // would be confusing — currently we just skip the check).
    GATEWAY_APIKEY_RPM_LIMIT: z.coerce.number().int().min(0).default(600),
  })
  .superRefine((data, ctx) => {
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
