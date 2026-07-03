#!/usr/bin/env bash
# Coverage gate runner. Runs the FULL module (./...), not just ./internal/...
# — watcher/, redact/, redact/parser/, and sink/ all live outside internal/
# and were previously invisible to this gate (the C1 --watch-all bug shipped
# undetected in part because watcher/ contributed 0% to coverage and was
# never run in CI). Excludes:
#   - internal/wizard/prompt_huh.go: interactive TTY code (StdinPrompter +
#     huh helpers) that cannot be unit-tested without a real terminal.
#     prompt.go (Prompter interface + FakePrompter) IS testable and counts.
#   - cmd/caliber-agent/: the main() entry point has no test file (it's a
#     thin os.Exit/signal-handling shim over internal/cli, which is fully
#     tested); including it would only dilute the percentage.
set -euo pipefail
cd "$(dirname "$0")/.."

go test ./... -race -coverprofile=cover-raw.out
grep -v -e "internal/wizard/prompt_huh.go" -e "cmd/caliber-agent/" cover-raw.out > cover.out
rm cover-raw.out
total=$(go tool cover -func=cover.out | tail -1 | awk '{print $3}' | tr -d %)
echo "total coverage: $total%"
awk -v t="$total" 'BEGIN { exit (t+0 < 80.0) }'
