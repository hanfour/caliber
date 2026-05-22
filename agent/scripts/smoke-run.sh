#!/usr/bin/env bash
# Manual smoke for the daemon main loop.
# Prereq: caliber-agent enroll already succeeded against a running stack.
# Until `caliber-agent add-path` lands in PR4, hand-edit
#   ~/.caliber-agent/config.toml to add at least one path to include_paths.
# Not in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

go build -o /tmp/caliber-agent-smoke ./cmd/caliber-agent

/tmp/caliber-agent-smoke run --once

echo "--- last 20 agent.log lines ---"
tail -20 "$HOME/.caliber-agent/agent.log"
echo "--- state.json ---"
cat "$HOME/.caliber-agent/state.json" | python3 -m json.tool | head -40

rm /tmp/caliber-agent-smoke
echo "PASS: tick completed"
