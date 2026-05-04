# Deploy aide to Fly.io

Three Fly apps (`aide-web`, `aide-api`, `aide-gateway`) plus Fly's
managed Postgres + an external Upstash Redis.

Fly doesn't have a true "click here to deploy" button — the closest
equivalent is `fly launch` from a fork. The TOML files in this
directory are the per-app launch templates.

## Prerequisites

| Item | Setup |
|---|---|
| Fly account + `flyctl` | <https://fly.io/docs/hands-on/install-flyctl/> |
| Upstash Redis | <https://console.upstash.com/redis/create> — Fly's bundled Redis is also Upstash-backed; either works |
| OAuth creds (Google + GitHub) | Same as `docs/SELF_HOSTING.md` §1 |
| Three secrets | `openssl rand -base64 48` × 1, `openssl rand -hex 32` × 2 |
| OpenAI org + project key | `docs/admin/openai-account-setup.md` |

## 1. Provision Postgres

Either use Fly's managed Postgres or external (Neon / Supabase). Fly is
simplest:

```sh
fly postgres create --name aide-postgres --region iad --vm-size shared-cpu-1x --volume-size 10
```

Save the `DATABASE_URL` it prints — needed in §3.

## 2. Provision Redis

If using Upstash directly:
1. <https://console.upstash.com/> → create database in your preferred region.
2. Copy the `redis://default:...` URL.

Or use Fly's bundled Redis (same Upstash backend, integrated billing):
```sh
fly redis create --name aide-redis --region iad --plan free
fly redis status aide-redis  # prints the URL
```

## 3. Launch each app

The three TOML files in this directory are pre-configured. From the
repo root:

```sh
# Web (Next.js admin UI)
fly launch --copy-config --config deploy/fly/web.toml --no-deploy
# Set secrets (web reads everything except infra IDs from env)
fly secrets set --app aide-web \
  AUTH_SECRET="$(openssl rand -base64 48)" \
  NEXTAUTH_URL="https://aide-web.fly.dev" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GITHUB_CLIENT_ID="..." \
  GITHUB_CLIENT_SECRET="..." \
  BOOTSTRAP_SUPER_ADMIN_EMAIL="admin@example.com" \
  DATABASE_URL="<from step 1>" \
  API_INTERNAL_URL="http://aide-api.flycast:3001"
fly deploy --config deploy/fly/web.toml

# API (private — no public IP)
fly launch --copy-config --config deploy/fly/api.toml --no-deploy
fly secrets set --app aide-api \
  AUTH_SECRET="<same value as web>" \
  NEXTAUTH_URL="https://aide-web.fly.dev" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GITHUB_CLIENT_ID="..." \
  GITHUB_CLIENT_SECRET="..." \
  BOOTSTRAP_SUPER_ADMIN_EMAIL="admin@example.com" \
  DATABASE_URL="<from step 1>" \
  REDIS_URL="<from step 2>"
fly deploy --config deploy/fly/api.toml
# IMPORTANT — disable public ingress on this app:
fly ips list --app aide-api
fly ips release --app aide-api  # release any auto-assigned public IPs

# Gateway (public — customer SDK target)
fly launch --copy-config --config deploy/fly/gateway.toml --no-deploy
fly secrets set --app aide-gateway \
  AUTH_SECRET="<same value>" \
  NEXTAUTH_URL="https://aide-web.fly.dev" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GITHUB_CLIENT_ID="..." \
  GITHUB_CLIENT_SECRET="..." \
  BOOTSTRAP_SUPER_ADMIN_EMAIL="admin@example.com" \
  DATABASE_URL="<from step 1>" \
  REDIS_URL="<from step 2>" \
  GATEWAY_BASE_URL="https://aide-gateway.fly.dev" \
  CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  API_KEY_HASH_PEPPER="$(openssl rand -hex 32)"
fly deploy --config deploy/fly/gateway.toml
```

## 4. Run schema migrations

Fly doesn't have a native one-shot job runner like the docker-compose
`migrate` service. Run inside the api container:

```sh
fly ssh console --app aide-api -C "node dist/migrate.js"
```

Repeat after every release that adds migrations.

## 5. Register OAuth callback URLs

Update Google + GitHub OAuth apps with redirect URIs:
- `https://aide-web.fly.dev/api/auth/callback/google`
- `https://aide-web.fly.dev/api/auth/callback/github`

(Or your custom domain after attaching one via `fly certs add`.)

## 6. Smoke test

```sh
curl -fsS https://aide-web.fly.dev/api/health
curl -fsS https://aide-gateway.fly.dev/health
```

Then sign in to the web app and walk through the OpenAI onboarding —
`docs/SELF_HOSTING.md` §6.5 has the step-by-step.

## 7. Custom domain (optional)

```sh
fly certs add --app aide-web aide.example.com
fly certs add --app aide-gateway gateway.example.com
# Update DNS as Fly instructs.
# Then update NEXTAUTH_URL + GATEWAY_BASE_URL secrets to use the new hosts:
fly secrets set --app aide-web NEXTAUTH_URL=https://aide.example.com
fly secrets set --app aide-api NEXTAUTH_URL=https://aide.example.com
fly secrets set --app aide-gateway NEXTAUTH_URL=https://aide.example.com GATEWAY_BASE_URL=https://gateway.example.com
# Re-register OAuth callbacks under the new hosts.
```

## Cost ballpark (Fly + Upstash, 2026)

| Service | $/month |
|---|---|
| `aide-web` (shared-cpu-1x, 512 MB, 1 instance) | ~$2 |
| `aide-api` (same shape, internal-only) | ~$2 |
| `aide-gateway` (shared-cpu-1x, 1 GB, 1 instance) | ~$5 |
| Fly Postgres (shared-cpu-1x, 10 GB volume) | ~$15 |
| Upstash Redis (free tier) | $0 |
| **Total** | **~$24/month** |

For HA: bump `min_machines_running = 2` on web/gateway, add a region
via `fly regions add ...`.

## Troubleshooting

### "Failed to start machine" with config error
The container's `parseServerEnv` is rejecting your env. View logs:
```sh
fly logs --app aide-gateway
```
Look for `Invalid environment configuration:` lines naming the
offending var. Fix with `fly secrets set ...` and the machine
restarts automatically.

### Gateway returns `no_upstream_available`
You haven't onboarded an OpenAI account yet via the admin UI.
Sign in to web, follow `docs/SELF_HOSTING.md` §6.5.

### Other issues
Same symptoms as Docker self-hosting — see `docs/SELF_HOSTING.md` §8.
