#!/usr/bin/env bash
# Manual smoke for the daemon main loop + ingest path.
# Prereq: caliber-agent enroll already succeeded against a running stack
# AND ~/.caliber-agent/config.toml has at least one path in include_paths
# AND that path has recent Claude or Codex transcript activity.
# Not in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

go build -o /tmp/caliber-agent-smoke ./cmd/caliber-agent

/tmp/caliber-agent-smoke run --once

echo "--- last 30 agent.log lines ---"
tail -30 "$HOME/.caliber-agent/agent.log"

if ! grep -q "\[ingest\]" "$HOME/.caliber-agent/agent.log"; then
  echo "FAIL: no [ingest] line in agent.log — daemon did not successfully POST to /v1/ingest"
  exit 1
fi

if ! grep -q "\[refresh\]\|\[debug\] redaction-set" "$HOME/.caliber-agent/agent.log"; then
  echo "WARN: no [refresh] line — set may be cached and not yet expired (informational)"
fi

echo "--- state.json offsets ---"
cat "$HOME/.caliber-agent/state.json" | python3 -m json.tool | head -40

rm /tmp/caliber-agent-smoke
echo "PASS: tick completed and at least one [ingest] confirmed"
