# BackupAndRestore

## Severity

procedural | critical (during actual restore)

## What needs to be backed up

| Data | Where | Loss impact |
|---|---|---|
| **Postgres** (all schema + rows) | `pg_data` Docker volume | Account credentials, api key hashes, usage logs, accountGroups, audit logs — **CATASTROPHIC if lost** |
| **Redis AOF** | `redis_data` Docker volume | Idempotency window, sticky session map, slot counters, OAuth refresh locks, rate-limit buckets — recoverable on its own (TTLs are short) but in-flight requests may double-execute |
| **Secrets** (`.env` / `.env.secrets`) | Operator machine + secret manager | Without `API_KEY_HASH_PEPPER`, every issued `ak_` becomes invalid by design — the loss equals "everyone needs a new key". Without `CREDENTIAL_ENCRYPTION_KEY`, every `credential_vault` row becomes unreadable — the loss equals "every upstream account must be re-onboarded". |
| **Container images** | Public ghcr.io | Pinning by tag in `.env` means image loss isn't a thing — re-pull on demand. |

## Backup procedure

### Daily — automated

Recommended: a host-level cron that snapshots Postgres nightly. Sample:

```bash
# Add to host crontab — daily 03:00 UTC, retain 14 days.
0 3 * * * cd /opt/aide/docker && \
  docker compose exec -T postgres pg_dumpall -U aide \
  | gzip -9 > /backups/aide-$(date -u +\%F).sql.gz \
  && find /backups -name 'aide-*.sql.gz' -mtime +14 -delete
```

Notes:
- `pg_dumpall` is logical (SQL text), portable across pg versions, larger
  on disk than `pg_basebackup`. Fine for the workload size aide handles.
- Compress with `gzip -9` — typical compression 8-15× on this schema.
- 14-day retention is a starting point — adjust per your data-retention
  policy. `usage_logs` is the bulk of the database size; if you have a
  TTL on it, set retention to `TTL + buffer`.

### Continuous — Redis AOF

Already enabled in `docker-compose.yml`:
```yaml
redis:
  command: ["redis-server", "--appendonly", "yes"]
  volumes:
    - redis_data:/data
```

The `redis_data` volume captures the AOF (append-only file) which Redis
replays on startup. Backing this up is **optional** — losing it means:
- Active idempotency windows reset (clients may see one duplicate
  request execute twice if they retry within the window). Bounded
  blast.
- OAuth refresh locks reset → a couple of duplicate refreshes against
  upstream OAuth endpoints. Tolerable.
- Rate limit counters reset → bursts allowed for one minute longer
  than they should be. Tolerable.

Most operators skip Redis backup. Snapshot the volume with the same
cron pattern if your audit/compliance posture requires it.

### Secrets — point-in-time

`AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER` are
generated once and never rotated except during a planned key-rotation
event. Store them in:

- Production: Docker secrets / k8s Secret / HashiCorp Vault / cloud
  secret manager (AWS Secrets Manager, GCP Secret Manager, etc.)
- Operator-archive: a chmod 600 `.env.secrets` on a separate host you
  also back up. **Never** in the same git repo as the rest of the
  project.

Rotate `AUTH_SECRET` if compromised — invalidates all browser sessions.
**Never rotate `API_KEY_HASH_PEPPER`** unless you're prepared to reissue
every customer's apiKey: the hash function is one-way pepper'd, and the
existing rows can't be re-hashed.

## Restore procedure (database)

Use case: ransomware, accidental TRUNCATE, regional cloud outage.

### Pre-flight

1. **Stop the application** so it can't write while you restore:
   ```sh
   cd docker
   docker compose --profile gateway stop api web gateway migrate
   # Postgres + Redis stay up — restore goes through them.
   ```
2. **Confirm the backup file** integrity:
   ```sh
   gzip -t /backups/aide-2026-05-15.sql.gz && echo OK
   ```
3. **Confirm secrets match the backup era** — `API_KEY_HASH_PEPPER` and
   `CREDENTIAL_ENCRYPTION_KEY` MUST be the same values that were live when
   the backup was taken. If you've rotated either since, restore
   from a backup that pre-dates the rotation OR accept that hashes /
   ciphertexts in the restored DB are opaque.

### Restore

```sh
# Drop + recreate the target database.  The pg_dumpall output contains
# CREATE DATABASE so we restore against `template1` to bootstrap.
docker compose exec postgres psql -U aide -d template1 -c "DROP DATABASE IF EXISTS aide;"
gunzip -c /backups/aide-2026-05-15.sql.gz \
  | docker compose exec -T postgres psql -U aide -d template1

# Verify a known-good row count.
docker compose exec postgres psql -U aide -d aide -c "
  SELECT 'users' AS t, COUNT(*) FROM users
  UNION ALL SELECT 'orgs', COUNT(*) FROM organizations
  UNION ALL SELECT 'accounts', COUNT(*) FROM upstream_accounts
  UNION ALL SELECT 'api_keys', COUNT(*) FROM api_keys
  UNION ALL SELECT 'usage_logs', COUNT(*) FROM usage_logs;
"
```

### Bring services back

```sh
docker compose --profile gateway up -d
docker compose --profile gateway logs --tail 50
```

Smoke-test as in the [upgrade procedure](./upgrade-procedure.md) §
"Verification metrics".

## Restore procedure (Redis only)

Rarely needed; usually faster to let it warm back up. If you must:

```sh
docker compose stop redis
# Replace redis_data volume contents with the backup.
docker compose start redis
docker compose exec redis redis-cli ping
```

In-flight idempotency / sticky / slot state may not match what the API
believes — accept a short window of weirdness, or do a `FLUSHDB` to
start clean.

## Disaster recovery (full host loss)

You need:
1. The latest Postgres backup file.
2. The `.env` file (or its content from your secret manager).
3. The `docker-compose.yml` and `.env.example` from
   [hanfour/aide](https://github.com/hanfour/aide) at the right
   `VERSION` tag.

Then:

```sh
git clone https://github.com/hanfour/aide.git /opt/aide
cd /opt/aide/docker
# Drop in your saved .env (with VERSION pinned to the backup era).
cp /secure/aide.env .env
# Bring up postgres + redis bare (without api/web/gateway).
docker compose up -d postgres redis
# Restore.
gunzip -c /backups/aide-latest.sql.gz \
  | docker compose exec -T postgres psql -U aide -d template1
# Bring up the rest.
docker compose up -d migrate
docker compose --profile gateway up -d
```

DNS swap to the new host, hit `/health` from the new origin, done.

## Restore drill (do this twice a year)

A backup you've never restored is not a backup.

Quarterly:
1. Spin up a throwaway VPS or local Docker host.
2. Run the disaster-recovery procedure above against the latest backup.
3. Sign in as `BOOTSTRAP_SUPER_ADMIN_EMAIL`, verify org list + accounts
   list + audit log.
4. Tear down. Note the RTO (time from "go" to "verified").

A passing drill takes about 15-25 min of human time + ~5 min of restore
wallclock for a typical few-GB database. If yours is much slower,
consider physical backups (`pg_basebackup`) for faster restore.

## Escalation

- Restore step fails with `ERROR: relation already exists` etc. → DB
  not properly dropped. Re-run the drop step then the restore.
- Restored data shows `credential_vault` rows but `resolveCredential`
  throws "auth tag mismatch" → `CREDENTIAL_ENCRYPTION_KEY` doesn't
  match the era of the backup. Find the right key from your secret
  archive.
- Restored data shows `api_keys.key_hash` but no client `ak_` works →
  same issue with `API_KEY_HASH_PEPPER`. There is no recovery path
  except reissuing keys.
- Backups are themselves missing → page incident commander; sound the
  data-loss alarm, follow your incident response.
