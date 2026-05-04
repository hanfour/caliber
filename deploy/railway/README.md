# Deploy aide to Railway

Railway provisions Postgres + Redis natively as plugin services, so a
typical deployment ends up with five Railway services in one project:

- `aide-postgres` (Postgres plugin)
- `aide-redis` (Redis plugin)
- `aide-web`
- `aide-api`
- `aide-gateway`

There's no single Railway template URL today (Railway's template
system requires the maintainer to publish a template through their
dashboard, which is outside the repo). Instead, this README walks you
through provisioning the services manually — about 10 minutes total.

## Prerequisites

| Item | Setup |
|---|---|
| Railway account + CLI | <https://docs.railway.app/guides/cli> — `npm i -g @railway/cli` |
| OAuth creds (Google + GitHub) | Same as `docs/SELF_HOSTING.md` §1 |
| Three secrets | `openssl rand -base64 48` × 1, `openssl rand -hex 32` × 2 |
| OpenAI org + project key | `docs/admin/openai-account-setup.md` |

## 1. Create a project + plugin services

```sh
railway init  # creates a new project from the current directory
# (or `railway link` to attach to an existing project)

# Plugins
railway add --plugin postgresql
railway add --plugin redis
```

Railway exposes the connection details via env-var references:

- `DATABASE_URL` — auto-injected when you add postgresql
- `REDIS_URL` — auto-injected when you add redis

## 2. Deploy each service

Railway expects each service to have its own Dockerfile path or image
URL. The cleanest pattern is three separate Railway "services" inside
the same project, each pointing at a different docker image.

### Web

```sh
# Via Railway dashboard:
# - New Service → Deploy from Docker image
# - Image: ghcr.io/hanfour/aide-web:latest
# - Service name: aide-web
# - Port: 3000

# Then set env vars (Variables tab):
NODE_ENV=production
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}
AUTH_SECRET=<openssl rand -base64 48>
NEXTAUTH_URL=https://<your-railway-web-domain>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_DEFAULT_ORG_SLUG=demo
BOOTSTRAP_DEFAULT_ORG_NAME=Demo
API_INTERNAL_URL=http://aide-api.railway.internal:3001
```

### API

Same pattern, image `ghcr.io/hanfour/aide-api:latest`, port `3001`:

```sh
NODE_ENV=production
PORT=3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
AUTH_SECRET=<same value as web>
NEXTAUTH_URL=https://<railway-web-domain>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_DEFAULT_ORG_SLUG=demo
BOOTSTRAP_DEFAULT_ORG_NAME=Demo
```

Mark this service "private" (no public domain) — only the web service
needs to reach it via Railway's internal network.

### Gateway

Image `ghcr.io/hanfour/aide-gateway:latest`, port `3002`:

```sh
NODE_ENV=production
ENABLE_GATEWAY=true
PORT=3002
GATEWAY_PORT=3002
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
AUTH_SECRET=<same value>
NEXTAUTH_URL=https://<railway-web-domain>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_DEFAULT_ORG_SLUG=demo
BOOTSTRAP_DEFAULT_ORG_NAME=Demo
GATEWAY_BASE_URL=https://<railway-gateway-domain>
CREDENTIAL_ENCRYPTION_KEY=<openssl rand -hex 32>
API_KEY_HASH_PEPPER=<openssl rand -hex 32>
GATEWAY_APIKEY_RPM_LIMIT=600
GATEWAY_CACHE_TTL_SEC=0
```

Public-facing — Railway auto-assigns `*.up.railway.app` host. Add a
custom domain later via the Settings tab.

## 3. Run schema migrations

Railway doesn't have a native one-shot job runner. Two options:

**Option A — exec into the api container:**

```sh
railway run --service aide-api -- node dist/migrate.js
```

**Option B — preDeploy on api service:**
Set the `Build Command` on `aide-api` to:
```
node dist/migrate.js && node dist/server.js
```

Slightly slower starts but ensures migrations run before each deploy.

## 4. Register OAuth callbacks

Same as the other deploy paths: register
`https://<your-railway-web-domain>/api/auth/callback/{google,github}`
with both providers.

## 5. First admin walkthrough

Same as `docs/SELF_HOSTING.md` §6.5. Sign in → onboard OpenAI account
→ optional pool → issue api key → smoke-test.

## Cost ballpark (Railway, 2026)

Railway charges by resource usage (~$5/month minimum). For typical
evaluation traffic with the smallest-tier services:

| Service | $/month |
|---|---|
| `aide-postgres` plugin | ~$5 |
| `aide-redis` plugin | ~$5 |
| `aide-web` | ~$5 |
| `aide-api` | ~$5 |
| `aide-gateway` | ~$5 |
| **Total** | **~$25/month** |

Resource-based billing means real cost depends on RPS / DB size.
Railway's pricing page has a calculator.

## Troubleshooting

### Service stuck on "Building" or "Not deployed"
Check the deploy logs. Most failures are missing env vars caught at
boot by `parseServerEnv` — the error message names the offending var.

### `${{Postgres.DATABASE_URL}}` not resolving
Both the postgres plugin and the consuming service must be in the
same Railway project. Verify with `railway link`.

### Gateway 503 / no_upstream
Same as other deploys — onboard an OpenAI account first.
