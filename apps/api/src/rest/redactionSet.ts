// apps/api/src/rest/redactionSet.ts
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { orgRedactionPatterns, type RedactionPattern } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuth } from "./ingestAuth.js";

const TTL_SECONDS = 86400; // 24h

// SERVER_DEFAULT_PATTERNS mirrors agent/redact/regexes.go DefaultPatterns.
// Drift between the two produces inconsistent behaviour when a daemon
// has no cached set and the server returns the default. A parity test
// in tests/integration/rest/redactionSet.test.ts asserts these match.
export const SERVER_DEFAULT_PATTERNS: RedactionPattern[] = [
  { name: "anthropic_or_openai_legacy", regex: "sk-[a-zA-Z0-9_\\-]{20,}", replacement: "sk-***" },
  { name: "openai_project",             regex: "sk-proj-[A-Za-z0-9_\\-]{20,}", replacement: "sk-proj-***" },
  { name: "anthropic_console",          regex: "sk-ant-api[0-9]{2}-[A-Za-z0-9_\\-]{20,}", replacement: "sk-ant-***" },
  { name: "aws_access_key",             regex: "AKIA[0-9A-Z]{16}", replacement: "AKIA***" },
  { name: "github_pat",                 regex: "ghp_[A-Za-z0-9]{36,}", replacement: "ghp_***" },
  { name: "github_oauth",               regex: "gho_[A-Za-z0-9]{36,}", replacement: "gho_***" },
  { name: "github_pat_fine_grained",    regex: "github_pat_[A-Za-z0-9_]{82}", replacement: "github_pat_***" },
  { name: "slack_bot",                  regex: "xoxb-[A-Za-z0-9\\-]{40,}", replacement: "xoxb-***" },
  { name: "slack_user",                 regex: "xoxp-[A-Za-z0-9\\-]{40,}", replacement: "xoxp-***" },
  { name: "groq",                       regex: "gsk_[A-Za-z0-9]{20,}", replacement: "gsk_***" },
  { name: "bearer_generic",             regex: "Bearer\\s+[A-Za-z0-9_\\-.]{20,}", replacement: "Bearer ***" },
];

function patternsVersion(patterns: RedactionPattern[]): string {
  const json = JSON.stringify(patterns);
  return createHash("sha256").update(json).digest("hex").slice(0, 8);
}

export function redactionSetRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/v1/redaction-set", async (req, reply) => {
      const auth = await resolveDeviceFromAuth(fastify.db, env, req.headers.authorization);
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          reply.code(500);
          return { error: "server_misconfigured" };
        }
        reply.code(401);
        return { error: auth.error };
      }
      const { orgId } = auth.device;

      const row = await fastify.db
        .select({ patterns: orgRedactionPatterns.patterns })
        .from(orgRedactionPatterns)
        .where(eq(orgRedactionPatterns.orgId, orgId))
        .limit(1)
        .then((r) => r[0]);

      const patterns = row?.patterns ?? SERVER_DEFAULT_PATTERNS;
      const version = row ? `org-${orgId}-${patternsVersion(patterns)}` : `default-${patternsVersion(patterns)}`;
      reply.code(200);
      return { patterns, version, ttl_seconds: TTL_SECONDS };
    });
  };
}
