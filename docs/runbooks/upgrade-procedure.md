# UpgradeProcedure

## Severity

procedural (not an alert; ran every release)

## When to use

- A new `aide` release is published on
  [GitHub Releases](https://github.com/hanfour/aide/releases) and you
  want to roll forward.
- You're unsure whether the release contains breaking schema changes
  or new required env vars.

## Pre-flight checklist

1. **Read the release notes** — check the GitHub release body for:
   - "BREAKING:" lines (require special handling)
   - New required env vars (the env schema in `packages/config/src/env.ts`
     enforces these at boot — the container will refuse to start)
   - New schema migrations (Drizzle migrations under `packages/db/drizzle/`
     applied automatically by the `migrate` service)
2. **Take a fresh DB snapshot** — see [`backup-and-restore.md`](./backup-and-restore.md).
3. **Capture current versions** for rollback reference:
   ```sh
   docker compose --profile gateway images
   ```
4. **Pick a low-traffic window** if you can — gateway downtime during
   rolling restart is ~10-30s.

## Standard upgrade (no breaking changes)

```sh
# 1. Bump VERSION in your env file.
sed -i '' 's/^VERSION=v[0-9.]*$/VERSION=v0.7.0/' docker/.env

# 2. Pull the new images.
cd docker
docker compose --profile gateway pull

# 3. Apply schema migrations (the migrate service runs forward-only and exits).
docker compose up -d migrate
docker compose logs migrate --tail 50  # confirm "Migrations complete." at end

# 4. Bring up api + web + gateway with the new images.
docker compose --profile gateway up -d

# 5. Verify health.
curl -fsS https://aide.example.com/api/health
curl -fsS https://gateway.example.com/health  # should print {"status":"ok"}

# 6. Smoke-test a request from a known-good apiKey.
curl -fsS https://gateway.example.com/v1/messages \
  -H "Authorization: Bearer ak_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' \
  | head -c 200
```

If all four checks pass, upgrade is complete.

## Upgrade with breaking changes

The release notes will call these out. Common patterns:

### New required env var
The migrate / gateway / api container will refuse to boot:
```
Invalid environment configuration:
  - GATEWAY_NEW_REQUIRED_VAR: Required
```

1. Add the var to `docker/.env`.
2. Re-run `docker compose --profile gateway up -d`.

### Schema migration with data backfill
If the release notes mention a multi-step migration:

1. The `migrate` service runs the forward SQL.
2. If a backfill script is required (rare), the release notes will name
   it and where to run from. Typically:
   ```sh
   docker compose run --rm api node dist/scripts/backfill-<name>.js
   ```
3. Re-run `migrate` if the release says so.

### Removed env var
The old var becomes ignored — no failure. Optionally clean it from
`docker/.env` for hygiene.

## Rolling back

If post-upgrade smoke tests fail and the issue is not obviously fixable:

```sh
# 1. Revert VERSION.
sed -i '' 's/^VERSION=v0.7.0$/VERSION=v0.6.0/' docker/.env

# 2. Pull the older images (if local cache is gone).
docker compose --profile gateway pull

# 3. Restart with the old images.
docker compose --profile gateway up -d
```

**Schema rollback caveat**: the `migrate` service is forward-only. If
you rolled forward and need to revert a release that included a schema
migration, you must:

1. Restore the DB from the snapshot taken in pre-flight (see
   [`backup-and-restore.md`](./backup-and-restore.md)).
2. THEN downgrade `VERSION`.

The opposite order (downgrade VERSION first, restore DB after) leaves
the older app talking to a newer schema — sometimes works, sometimes
crashes mid-write. Don't gamble.

Some releases ship with a `0XYZ_down.sql` next to the forward migration —
those let you run a one-shot rollback without restoring from snapshot.
Check the release notes.

## Verification metrics (~5 min after upgrade)

```bash
# No spike in 5xx.
curl -s http://gateway:3002/metrics | grep gw_request_total | tail -10

# Rate limit + cache plumbing intact.
curl -fsS https://gateway.example.com/v1/messages \
  -H "Authorization: Bearer ak_..." \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' \
  -i | grep -E 'x-ratelimit|x-cache'

# OAuth refresh background scan still running.
docker compose --profile gateway logs gateway --since 5m | grep oauth-refresh-scan

# BullMQ queues healthy.
docker compose exec redis redis-cli zcard 'aide:gw:bull:usage-log:wait'
```

## Escalation

- Migration step fails halfway → page DBA / platform-eng. Don't `migrate up`
  again until the partial state is understood (Drizzle is forward-only;
  re-running can do nothing or compound damage depending on the failure).
- Smoke test fails on production after rollback → page incident commander
  (we're now in "neither version works" territory).
- Customer reports degraded responses post-upgrade → run
  [`rpm-limit-triggered.md`](./rpm-limit-triggered.md) and
  [`cache-issues.md`](./cache-issues.md) diagnosis paths.
