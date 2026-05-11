#!/usr/bin/env bash
# Phase 3 maintenance migration: aide → Caliber infra rename.
#
# Run this ONCE on the host running the Caliber stack (h4 in our case).
# Estimated downtime: 5–10 minutes. The mac-mini / external clients
# cannot reach the gateway during steps 3–9.
#
# Pre-conditions:
#   • main contains the Phase 3 rebrand commit
#   • v0.5.0 is tagged AND release CI has finished pushing
#     ghcr.io/hanfour/caliber-{api,web,gateway}:v0.5.0
#   • You're running this script from a checked-out repo (the script
#     uses scripts/keychain-helper/install.sh for the launchd swap).
#
# Idempotent-ish: re-running is safe if a previous run was interrupted
# AFTER step 2 (DB rename) — subsequent SQL ALTERs become no-ops; the
# script detects that. Re-running BEFORE step 2 is fully safe.
#
# Bails on any error (`set -e`). On failure, see the BACKUP_DIR for
# restore artifacts and follow the rollback notes printed at the end.

set -euo pipefail

REPO="${REPO:-/Users/hanfourhuang/ai-dev-eval}"
NEW_VERSION="${NEW_VERSION:-v0.5.0}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/caliber-rebrand-backup-$(date +%Y%m%d-%H%M%S)}"

OLD_LABEL="com.hanfour.aide.keychain-helper"
NEW_LABEL="com.hanfour.caliber.keychain-helper"
LA_DIR="$HOME/Library/LaunchAgents"

cd "$REPO"

# Sanity: this script and the install.sh both expect to be in the
# repo. Bail if the user accidentally ran it from somewhere else.
[ -f docker/docker-compose.yml ] || { echo "ERROR: expected to be in repo root"; exit 1; }
[ -f scripts/keychain-helper/install.sh ] || { echo "ERROR: install.sh missing"; exit 1; }

mkdir -p "$BACKUP_DIR"
echo "==> Backup dir: $BACKUP_DIR"

# ────────────────────────────────────────────────────────────────────
# 1. Backup Postgres + Redis + .env + old plist
# ────────────────────────────────────────────────────────────────────

echo "==> Step 1/9: snapshot before changing anything"

# Detect current DB name (rename-resilient: may already be 'caliber'
# if we're re-running after a partial migration).
CURRENT_DB="$(docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U postgres -tA -c \
  "SELECT datname FROM pg_database WHERE datname IN ('aide','caliber') LIMIT 1;" \
  2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$CURRENT_DB" ]; then
  echo "ERROR: cannot find 'aide' or 'caliber' DB. Is postgres up?"
  exit 1
fi
echo "    detected current DB: $CURRENT_DB"

# Detect current DB role.
CURRENT_USER="$(docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U postgres -tA -c \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('aide','caliber') LIMIT 1;" \
  | tr -d '[:space:]')"
echo "    detected current role: $CURRENT_USER"

if [ "$CURRENT_DB" = "aide" ]; then
  docker compose -f docker/docker-compose.yml exec -T postgres \
    pg_dump -U "$CURRENT_USER" -Fc aide > "$BACKUP_DIR/aide-db.dump"
  echo "    pg_dump: $BACKUP_DIR/aide-db.dump ($(du -h "$BACKUP_DIR/aide-db.dump" | cut -f1))"
else
  echo "    DB already renamed; skipping pg_dump"
fi

# Redis backup is best-effort — keys are ephemeral; loss is acceptable.
docker compose -f docker/docker-compose.yml exec -T redis redis-cli BGSAVE >/dev/null 2>&1 || true
docker compose -f docker/docker-compose.yml cp redis:/data/dump.rdb "$BACKUP_DIR/redis-dump.rdb" 2>/dev/null || \
  echo "    (redis snapshot skipped — keys are ephemeral)"

cp docker/.env "$BACKUP_DIR/.env.before"
[ -f "$LA_DIR/$OLD_LABEL.plist" ] && cp "$LA_DIR/$OLD_LABEL.plist" "$BACKUP_DIR/"

# ────────────────────────────────────────────────────────────────────
# 2. Stop running services (keep postgres + redis up for the rename)
# ────────────────────────────────────────────────────────────────────

echo "==> Step 2/9: stop api/web/gateway (postgres + redis stay up)"
docker compose -f docker/docker-compose.yml --profile gateway stop gateway web api migrate 2>/dev/null || true

# ────────────────────────────────────────────────────────────────────
# 3. Postgres rename
# ────────────────────────────────────────────────────────────────────

echo "==> Step 3/9: rename Postgres DB + role"
docker compose -f docker/docker-compose.yml exec -T postgres psql -U postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN ('aide','caliber') AND pid <> pg_backend_pid();
DO $$BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname='aide') THEN
    EXECUTE 'ALTER DATABASE aide RENAME TO caliber';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aide') THEN
    EXECUTE 'ALTER ROLE aide RENAME TO caliber';
  END IF;
END$$;
SQL
echo "    DB + role renamed (or already-caliber, no-op)"

# ────────────────────────────────────────────────────────────────────
# 4. Flush Redis (queues + caches rebuild on first use)
# ────────────────────────────────────────────────────────────────────

echo "==> Step 4/9: flush Redis (BullMQ queues + ephemeral caches)"
docker compose -f docker/docker-compose.yml exec -T redis redis-cli FLUSHALL >/dev/null
echo "    redis FLUSHALL done"

# ────────────────────────────────────────────────────────────────────
# 5. docker/.env — ensure all values point at caliber + v0.5.0
# ────────────────────────────────────────────────────────────────────

echo "==> Step 5/9: rewrite docker/.env"
sed -i.bak -E \
  -e 's|^DB_USER=.*|DB_USER=caliber|' \
  -e 's|^DB_NAME=.*|DB_NAME=caliber|' \
  -e "s|^VERSION=.*|VERSION=$NEW_VERSION|" \
  -e 's|^GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH=.*|GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH=/run/caliber-keychain.token|' \
  docker/.env
rm docker/.env.bak
grep -E '^(DB_USER|DB_NAME|VERSION|GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH)=' docker/.env

# ────────────────────────────────────────────────────────────────────
# 6. Swap launchd keychain helper
# ────────────────────────────────────────────────────────────────────

echo "==> Step 6/9: swap launchd helper (aide → caliber)"

# Unload old job if still loaded
if [ -f "$LA_DIR/$OLD_LABEL.plist" ]; then
  launchctl unload "$LA_DIR/$OLD_LABEL.plist" 2>/dev/null || true
  mv "$LA_DIR/$OLD_LABEL.plist" "$BACKUP_DIR/"
fi

# Migrate token directory (preserves the token so the helper doesn't
# regenerate it and force every container to re-read).
if [ -d "$HOME/.aide" ] && [ ! -d "$HOME/.caliber" ]; then
  mv "$HOME/.aide" "$HOME/.caliber"
  chmod 700 "$HOME/.caliber"
elif [ ! -d "$HOME/.caliber" ]; then
  mkdir -p "$HOME/.caliber"
  chmod 700 "$HOME/.caliber"
fi

# Install new helper via the repo's idempotent installer
bash scripts/keychain-helper/install.sh

# ────────────────────────────────────────────────────────────────────
# 7. Pull caliber-* v0.5.0 images
# ────────────────────────────────────────────────────────────────────

echo "==> Step 7/9: pull caliber-* $NEW_VERSION images"
docker compose -f docker/docker-compose.yml --profile gateway pull

# ────────────────────────────────────────────────────────────────────
# 8. Bring stack up on new compose
# ────────────────────────────────────────────────────────────────────

echo "==> Step 8/9: docker compose up -d"
docker compose -f docker/docker-compose.yml --profile gateway up -d

echo "    waiting for healthy…"
TIMEOUT=120
WAITED=0
while :; do
  unhealthy=$(docker compose -f docker/docker-compose.yml ps --status running -q \
    | xargs -I{} docker inspect -f '{{.State.Health.Status}}' {} 2>/dev/null \
    | grep -vE '^(healthy|)$' || true)
  if [ -z "$unhealthy" ]; then break; fi
  WAITED=$((WAITED + 3))
  if [ "$WAITED" -ge "$TIMEOUT" ]; then
    echo "ERROR: containers still not healthy after $TIMEOUT s"
    docker compose -f docker/docker-compose.yml ps
    exit 1
  fi
  sleep 3
done
echo "    all healthy"

# ────────────────────────────────────────────────────────────────────
# 9. Smoke test
# ────────────────────────────────────────────────────────────────────

echo "==> Step 9/9: smoke test"
HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3002/health)
if [ "$HEALTH" != "200" ]; then
  echo "ERROR: gateway /health returned $HEALTH"
  exit 1
fi
echo "    gateway /health = 200"

WEB=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000/dashboard)
if [ "$WEB" != "200" ] && [ "$WEB" != "307" ] && [ "$WEB" != "302" ]; then
  echo "ERROR: web /dashboard returned $WEB"
  exit 1
fi
echo "    web /dashboard = $WEB"

echo
echo "==> Migration complete."
echo "    Backup: $BACKUP_DIR"
echo
echo "Rollback (if needed):"
echo "  1. docker compose down"
echo "  2. cp $BACKUP_DIR/.env.before docker/.env"
echo "  3. docker compose up -d postgres redis"
echo "  4. docker compose exec postgres psql -U postgres -c 'ALTER DATABASE caliber RENAME TO aide; ALTER ROLE caliber RENAME TO aide;'"
echo "  5. mv ~/.caliber ~/.aide"
echo "  6. bash scripts/keychain-helper/install.sh --uninstall"
echo "  7. cp $BACKUP_DIR/$OLD_LABEL.plist ~/Library/LaunchAgents/ && launchctl load \$_"
echo "  8. (Optional) restore docker-compose.yml from prior git commit"
echo "  9. docker compose up -d"
