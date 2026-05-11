#!/usr/bin/env bash
#
# Install (or re-install) the caliber-keychain-helper LaunchAgent.
#
# Idempotent: re-running picks up source changes (replaces the plist
# with absolute paths substituted, unloads the existing service if
# present, reloads it).
#
# Usage:
#   ./install.sh         # install + start
#   ./install.sh --uninstall
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.hanfour.caliber.keychain-helper"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
CALIBER_DIR="$HOME/.caliber"
TOKEN_PATH="$CALIBER_DIR/keychain.token"
HELPER_PORT="${CALIBER_KEYCHAIN_PORT:-47823}"
HELPER_HOST="${CALIBER_KEYCHAIN_HOST:-127.0.0.1}"

uninstall() {
  if [ -f "$PLIST_DEST" ]; then
    echo "→ unloading $LABEL"
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
  fi
  echo "✓ uninstalled"
  echo "  (token at $TOKEN_PATH preserved — delete manually if you want a fresh one on reinstall)"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: keychain helper is macOS-only (uses /usr/bin/security)" >&2
  exit 1
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH; install Node.js first" >&2
  exit 1
fi
# launchd starts processes with a stripped PATH (no nvm shims, no
# /opt/homebrew/bin), so the plist's `/usr/bin/env node` lookup will
# fail when node lives under nvm. Substitute the discovered absolute
# path into the plist instead.

mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR" "$CALIBER_DIR"
chmod 700 "$CALIBER_DIR"

# Pre-create the helper's log file with owner-only perms. launchd
# would otherwise create it with the default 0644, exposing the
# helper's pino-style log lines (op + outcome — no token contents,
# but `security`-tool error messages can mention the keychain item
# name + path) to other users on shared hosts.
LOG_FILE="$LOG_DIR/caliber-keychain-helper.log"
if [ ! -f "$LOG_FILE" ]; then
  : > "$LOG_FILE"
fi
chmod 600 "$LOG_FILE"

# Substitute absolute paths into the plist template.
PLIST_SRC="$SCRIPT_DIR/caliber-keychain-helper.plist"
sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__INSTALL_DIR__|$SCRIPT_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

# If a previous version is loaded, unload first so reload picks up
# the new plist.
launchctl unload "$PLIST_DEST" 2>/dev/null || true

launchctl load "$PLIST_DEST"

# Wait briefly for the helper to bind the port before declaring success.
for _ in 1 2 3 4 5; do
  if nc -z "$HELPER_HOST" "$HELPER_PORT" 2>/dev/null; then
    if [ ! -f "$TOKEN_PATH" ]; then
      sleep 1
      continue
    fi
    TOKEN="$(cat "$TOKEN_PATH")"
    echo "✓ installed + running"
    echo "  endpoint: $HELPER_HOST:$HELPER_PORT"
    echo "  token:    $TOKEN_PATH (mode 0600)"
    echo "  log:      $LOG_DIR/caliber-keychain-helper.log"
    echo
    echo "Test (host):"
    echo "  echo \"{\\\"op\\\":\\\"ping\\\",\\\"auth\\\":\\\"\$(cat $TOKEN_PATH)\\\"}\" | nc $HELPER_HOST $HELPER_PORT"
    echo
    echo "Container side: docker compose mounts the token file via:"
    echo "  ${CALIBER_DIR}/keychain.token:/run/caliber-keychain.token:ro"
    echo "and the gateway env points at host.docker.internal:$HELPER_PORT"
    exit 0
  fi
  sleep 1
done

echo "WARN: helper did not start listening within 5s. Check logs:" >&2
echo "  tail -n 20 $LOG_DIR/caliber-keychain-helper.log" >&2
exit 1
