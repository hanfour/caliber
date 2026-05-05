#!/bin/sh
# Substitute the API_INTERNAL_URL placeholder into Next.js's
# routes-manifest.json before booting the standalone server. See the comment
# in apps/web/next.config.mjs for why the placeholder dance is necessary —
# Next.js bakes rewrites at build time, but operators set this URL at deploy
# time. Default matches the docker-compose service name.
set -eu

: "${API_INTERNAL_URL:=http://api:3001}"
export API_INTERNAL_URL
# Shared substitution helper — same script the npm `start` path uses, so
# the placeholder swap behaves identically inside and outside Docker.
node /app/apps/web/scripts/substitute-api-url.mjs

exec node apps/web/server.js
