#!/usr/bin/env node
// Substitute the API_INTERNAL_URL placeholder out of the baked
// routes-manifest.json before booting the Next.js server. See the comment
// in apps/web/next.config.mjs for the full rationale — Next.js standalone
// bakes rewrites() at build time, so a runtime env var can't otherwise reach
// them. Wired into both `next start` (via package.json) and the Docker
// entrypoint (docker/web-entrypoint.sh).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = path.resolve(here, "..", ".next", "routes-manifest.json");
const PLACEHOLDER = "http://aide-internal-api-url-placeholder";
const value = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

if (!existsSync(manifest)) {
  // `next start` will fail with its own clearer error if the manifest
  // is genuinely missing; a noisy log here would just bury that.
  process.exit(0);
}

const contents = readFileSync(manifest, "utf8");
if (!contents.includes(PLACEHOLDER)) process.exit(0);

writeFileSync(manifest, contents.replaceAll(PLACEHOLDER, value));
