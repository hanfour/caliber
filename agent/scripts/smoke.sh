#!/usr/bin/env bash
# Manual smoke against running local caliber stack.
# Not in CI. Run before merging PR1.
set -euo pipefail

TOKEN="${1:?usage: $0 <enrollment-token>}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# Build runs inside the agent module — relative ./cmd path is module-relative.
( cd "$(dirname "$0")/.." && go build -o "$WORKDIR/caliber-agent" ./cmd/caliber-agent )

CALIBER_API_BASE_URL=http://localhost:3001 \
CALIBER_AGENT_HOME="$WORKDIR/home" \
  "$WORKDIR/caliber-agent" enroll "$TOKEN"

security find-generic-password -s tw.caliber.agent >/dev/null && echo "PASS: keychain entry exists"
test -f "$WORKDIR/home/config.toml" && echo "PASS: config.toml exists"
grep -q 'include_paths = \[\]' "$WORKDIR/home/config.toml" && echo "PASS: include_paths defaults empty"
