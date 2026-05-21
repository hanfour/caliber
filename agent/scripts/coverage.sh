#!/usr/bin/env bash
# Coverage gate runner. Excludes prompt_huh.go and prompt.go (StdinPrompter)
# which are interactive TTY code that cannot be unit-tested without a real terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

go test ./internal/... -race -coverprofile=cover-raw.out
grep -v "internal/wizard/prompt_huh.go\|internal/wizard/prompt.go" cover-raw.out > cover.out
rm cover-raw.out
total=$(go tool cover -func=cover.out | tail -1 | awk '{print $3}' | tr -d %)
echo "total coverage: $total%"
awk -v t="$total" 'BEGIN { exit (t+0 < 80.0) }'
