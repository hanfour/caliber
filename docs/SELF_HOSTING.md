# Self-hosting aide

This guide walks you through running `aide` (platform mode) on your own
infrastructure using the published Docker images. For CLI mode, see the root
`README.md`.

## 1. Prerequisites

- **Docker 27+** with the `compose` plugin (`docker compose version`).
- A **domain name** you control (e.g. `aide.example.com`) pointing at the host.
- **OAuth applications** registered with:
  - Google Cloud Console — OAuth 2.0 Client ID
  - GitHub Developer Settings — OAuth App
- For each provider, set the authorized redirect URL to:
  `https://<your-domain>/api/auth/callback/<provider>`
  (e.g. `https://aide.example.com/api/auth/callback/google`).

A reverse proxy (Caddy, Traefik, Nginx) in front of the web container handles
TLS termination. The compose stack itself only exposes web on port 3000.

## 2. Grab the compose files

```sh
git clone https://github.com/hanfour/aide.git
cd aide/docker
cp .env.example .env
```

Then edit `.env` and fill in:

| Var | Meaning |
|---|---|
| `VERSION` | The image tag to pull (e.g. `v0.2.0`). See [releases](https://github.com/hanfour/aide/releases). |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Postgres credentials (stay internal to the compose network). |
| `AUTH_SECRET` | **≥32 bytes** of randomness. Generate with `openssl rand -base64 48`. |
| `NEXTAUTH_URL` | Public URL users sign in from. Must match the OAuth redirect host. |
| `GOOGLE_CLIENT_ID/SECRET` | From Google Cloud Console. |
| `GITHUB_CLIENT_ID/SECRET` | From GitHub Developer Settings. |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | The first email to sign in gets `super_admin`. |
| `BOOTSTRAP_DEFAULT_ORG_SLUG/NAME` | A default org is created on first sign-in. |

## 3. First run

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

What happens in order:
1. `postgres` comes up and passes its healthcheck.
2. `migrate` runs once against the fresh DB — applies all Drizzle migrations.
3. `api` starts and becomes healthy when `/health` responds.
4. `web` starts and begins proxying `/trpc` and `/api/v1` to `api` over the
   internal compose network.

Once healthy, point your reverse proxy at `web:3000` and sign in at
`https://<your-domain>/sign-in` using the email you set as
`BOOTSTRAP_SUPER_ADMIN_EMAIL`. You'll be granted `super_admin` automatically
and the default org will be created.

## 4. Updating

Pin a new `VERSION` in `.env`, then:

```sh
docker compose pull
docker compose up -d
```

The `migrate` service reruns automatically — it only applies migrations that
haven't been applied yet. Downtime is roughly the time to start the new
containers (a few seconds).

## 5. Backup

The only durable state is the Postgres volume `docker_pg_data`. Recommended
approach: scheduled `pg_dump` from the running container.

```sh
docker compose exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
  > "aide-$(date +%F).dump"
```

Restore into a fresh volume with:

```sh
docker compose exec -T postgres \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --clean < aide-YYYY-MM-DD.dump
```

Keep backups encrypted and off-host.

## 6. (Optional) Enable the gateway

aide ships an optional **gateway** service (Plan 4A, v0.3.0+) that exposes
Anthropic-compatible `/v1/messages` and OpenAI-compatible `/v1/chat/completions`
endpoints to your users. It is fully opt-in — the base compose stack above
runs api + web without it.

If you don't plan to offer a shared upstream pool, skip this section. For the
full operator + user guide, see [`GATEWAY.md`](./GATEWAY.md).

### 6.1 What gets added

- **`redis:7-alpine`** service — already part of the base compose file so
  future features (sticky sessions, idempotency) can reuse it without another
  compose change. Persists to the `redis_data` volume.
- **`gateway`** service — a Fastify server on port 3002 gated behind the
  `gateway` docker-compose profile. Not started unless you pass
  `--profile gateway`.
- Public image: `ghcr.io/hanfour/aide-gateway:${VERSION}` (multi-arch
  `linux/amd64,linux/arm64`, published on every `v*` tag).

### 6.2 New env vars

Append to your `docker/.env`:

| Var | Meaning |
|---|---|
| `GATEWAY_BASE_URL` | Public URL your users point their SDK at (e.g. `https://gateway.example.com`). Shown in the one-time key-reveal page. |
| `CREDENTIAL_ENCRYPTION_KEY` | **Secret.** 32 bytes hex (64 chars). AES-256-GCM master key for the credential vault. Generate with `openssl rand -hex 32`. **Never commit this value.** |
| `API_KEY_HASH_PEPPER` | **Secret.** 32 bytes hex (64 chars). HMAC-SHA256 pepper for API key hashing. Generate with `openssl rand -hex 32`. **Losing this value invalidates every issued key by design.** |
| `GATEWAY_PORT` | Host port published for the gateway service. Default `3002`. |
| `REDIS_URL` | Only needed if you run the gateway **outside** this compose file. The shipped `gateway` service hard-codes `redis://redis:6379` (the internal compose hostname), so you don't need to set this when you use `docker compose --profile gateway up`. |

All other gateway vars (`GATEWAY_MAX_ACCOUNT_SWITCHES`,
`GATEWAY_REDIS_FAILURE_MODE`, etc.) have sensible defaults and are documented
in [`GATEWAY.md#2-configuration`](./GATEWAY.md#2-configuration).  Two of them
are particularly worth knowing about for a first deploy:

- **`GATEWAY_APIKEY_RPM_LIMIT`** (default 600 ≈ 10 RPS sustained) — protects
  the upstream-account pool from a runaway client. Rate-limit headers are
  emitted on every response (`x-ratelimit-limit`, `x-ratelimit-remaining`)
  so client SDKs can self-throttle. Over-limit calls get 429 + `Retry-After`.
  Set to `0` to disable temporarily during an incident; long-term tune up or
  down based on observed traffic.
- **`GATEWAY_CACHE_TTL_SEC`** (default `0` = OFF) — opt-in response cache
  for non-streaming `/v1/*` endpoints. When >0, identical
  `(orgId, endpoint, body)` requests within the TTL window short-circuit
  upstream and return the cached response with `x-cache: hit`. Cached
  payloads contain model output (not prompts); confirm your data
  classification permits this before enabling. Recommended first-deploy
  rollout: keep at 0 for the first week, observe, then enable with a short
  TTL (60-300s).

For production, inject `CREDENTIAL_ENCRYPTION_KEY` and `API_KEY_HASH_PEPPER`
via Docker secrets or your orchestrator's secret mount — do not leave them in
a plain `.env`. A simple pattern is to store them in a separate
`.env.secrets` file (chmod 600, not in git) and reference it from the
`gateway` service with `env_file: .env.secrets`.

### 6.3 Start the gateway

Once the vars are in `docker/.env`:

```sh
cd docker
docker compose --profile gateway up -d
docker compose --profile gateway logs -f gateway
```

What happens:
1. `redis` was already up (base profile).
2. `gateway` waits for `postgres` to be healthy + `migrate` to complete.
3. On boot, `parseServerEnv` validates the secrets (64-char hex, URL shape,
   etc.) and fails fast with a clear error if anything is missing.
4. Fastify binds `0.0.0.0:3002`. `GET /health` returns `{"status":"ok"}`.

**Put a TLS-terminating reverse proxy in front of port 3002** (Caddy /
Traefik / Nginx / cloud LB) exactly as you already do for port 3000 (web).
User-supplied API keys travel in the `x-api-key` header — plain HTTP is not
acceptable.

### 6.4 Updating the gateway

Same workflow as the base stack (§4): bump `VERSION` in `.env`, then

```sh
docker compose --profile gateway pull
docker compose --profile gateway up -d
```

The gateway has no migrations of its own beyond what `migrate` already
ran — schema changes ship with new releases of `apps/api`.

### 6.5 First-time admin walkthrough — onboarding an OpenAI account

After the gateway service is up and a `super_admin` has signed in, work
through this checklist once to put real traffic through the stack. (Skip
the OpenAI parts if you're starting with Anthropic.)

1. **Provision OpenAI org / project** — sign in at
   <https://platform.openai.com/>, create an org if needed, set a monthly
   spend cap, and create a Project (e.g. `aide-prod`) under that org with
   its own per-project spend cap.  Mint a **project API key**
   (`sk-proj-...`) scoped to inference only. Full step-by-step in
   [`admin/openai-account-setup.md`](./admin/openai-account-setup.md).
2. **Add the upstream account** — in the admin UI go to
   `/dashboard/organizations/<org>/accounts`, click "New account",
   pick **OpenAI** + **API key**, paste the `sk-proj-...` value, choose
   org-wide or team-specific scope, save.
3. **(Optional) Build a pool** — if you have multiple OpenAI project
   keys (e.g. one per business unit budget), create them as separate
   accounts and group them under `/dashboard/organizations/<org>/account-groups`.
   Set per-member priority — the scheduler picks lowest first.
4. **Issue a client API key** — go to **Profile → Generate new API
   key**. Copy the one-time `ak_...` value (the gateway hashes it on
   submit; you cannot recover it).
5. **Smoke test from a client** —
   ```sh
   curl https://gateway.example.com/v1/chat/completions \
     -H "Authorization: Bearer ak_..." \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
   ```
   You should get a 200 with response headers including
   `x-ratelimit-limit: 600`, `x-ratelimit-remaining: 599`, and (when
   `GATEWAY_CACHE_TTL_SEC>0`) `x-cache: miss`. A second identical call
   within the TTL window flips to `x-cache: hit`.
6. **Verify usage logging** — `/dashboard/profile/usage` (or the
   org-wide dashboard for `org_admin`) shows the call within ~30s.

If a step fails, check `docker compose --profile gateway logs gateway`
for the structured error. Credential material is redacted in logs
automatically (Phase 3 #4-a) — operator messages are safe to share.

### 6.6 Feature flag (process-level)

`ENABLE_GATEWAY=true` is baked into the gateway service definition. If you
ever need to boot the gateway container in a "surface-off" mode (e.g. during
incident response to take it out of rotation without tearing down the
compose project), set `ENABLE_GATEWAY=false` in your env — the process will
only serve `/health` returning `{"status":"disabled"}` and will not register
`/v1/*` routes. It does **not** `process.exit` in this state, so your
orchestrator won't restart-loop.

See [`GATEWAY.md#10-feature-flag`](./GATEWAY.md#10-feature-flag) for the full
gating layer list.

## 7. (Optional) Enable the evaluator (Plan 4B+)

The evaluator is an opt-in subsystem that captures AI conversation content and
scores each member's AI-assisted development quality. It is DISABLED by default.

### 7.1 Prerequisites

- Gateway must be wired (see Section 6 above) — evaluator depends on the
  body-capture pipeline and LLM loopback.
- `CREDENTIAL_ENCRYPTION_KEY` is required — the evaluator reuses this master
  key (with a different HKDF domain string) to encrypt captured request/response
  bodies.

### 7.2 Environment variables

Add to your `docker/.env`:

| Var | Meaning |
|---|---|
| `ENABLE_EVALUATOR` | Master gate (`true` or `false`, default `false`). When `true`, exposes evaluator tRPC endpoints, admin UI pages, and evaluation cron. |
| `GATEWAY_LOCAL_BASE_URL` | Used by the evaluator worker for loopback LLM calls. Defaults to `http://localhost:3002` if unset. |

### 7.3 Per-org UI settings

Once `ENABLE_EVALUATOR=true`, admins configure per-org via Settings UI (not env):

- **Content capture toggle** — master switch for that org.
- **Retention override** — 30/60/90 days (default 90).
- **LLM Deep Analysis** — opt-in toggle + upstream account + model selection.
- **Thinking capture** — opt-in toggle to also capture extended-thinking
  content.
- **Rubric** — select platform-default or create custom.
- **Leaderboard** — opt-in peer-visible ranking for teams.

### 7.4 First-enable workflow

1. Set `ENABLE_EVALUATOR=true` in `docker/.env` and redeploy.
2. Run `pnpm -F @aide/db db:migrate` to apply migration 0002.
3. Navigate to `/dashboard/organizations/[id]/evaluator/settings` and enable
   content capture.
4. (Optional) Navigate to `/dashboard/organizations/[id]/evaluator/rubrics` to
   customize the evaluation rubric.
5. Verify the daily cron at 00:05 UTC produces reports on
   `/dashboard/profile/evaluation`.

### 7.5 Operational notes

- **GDPR delete requests** are member-initiated + admin-approved; see
  `EVALUATOR.md` for the workflow.
- **Metrics** — look for `gw_body_*` and `gw_eval_*` counters on the `/metrics`
  endpoint for observability.
- **Cost** — LLM Deep Analysis calls land in `usage_logs` under the provisioned
  evaluator api_key; visible via existing Usage reports.

## 8. Troubleshooting

### OAuth redirect errors

The most common failure: `redirect_uri_mismatch`. The registered URL in
Google/GitHub must be **exactly** `https://<host>/api/auth/callback/<provider>`
with no trailing slash and with the scheme Users actually hit.

### `/health/ready` returns 503

Usually means migrations haven't run. Check `docker compose logs migrate`.
If `migrate` exited non-zero, `api` and `web` will never start — investigate
the migration error before restarting the stack.

### `OAuthAccountNotLinked`

A user already has an account with one provider and tried a different one
for the same email. Sign in with the original provider, then link the second
provider from Profile.

### `api` marked unhealthy

Run `docker compose exec api wget -qO- http://localhost:3001/health`. If the
response is `db: down`, Postgres is unreachable — check network and
credentials. If Postgres is fine, check `docker compose logs api` for the
underlying error.

### Resetting completely

**Destructive — wipes all data.**

```sh
docker compose down --volumes
```

## 9. Reference

- Production compose: [`docker/docker-compose.yml`](../docker/docker-compose.yml)
- Env schema: [`packages/config/src/env.ts`](../packages/config/src/env.ts)
- Releases / image tags: <https://github.com/hanfour/aide/releases>
