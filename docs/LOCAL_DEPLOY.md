# Local deployment guide

> **Looking for an end-to-end "from zero to working personal AI
> gateway" tutorial?** See
> [`GETTING_STARTED.md`](./GETTING_STARTED.md) — it walks through
> Mode 1 + Mode 2 (Anthropic OAuth) + cross-device wiring as one
> linear ~30-minute path, with workarounds inline. This doc remains
> the deeper reference for each mode in isolation.

Three escalating modes for running aide on your own machine — pick
the lowest one that fits your goal:

| Mode | Goal | Time | Prerequisites |
|---|---|---|---|
| **1. Pure local evaluation** | See the admin UI, click around, validate the system works end-to-end against ChatGPT-OAuth-style fixtures | ~5 min | Docker Desktop, openssl, an OAuth app (Google or GitHub) |
| **2. Local + real OpenAI** | Drive a real `sk-proj-...` key through the gateway, observe rate-limit / cache headers, exercise the admin onboarding flow with live data | +5 min | Mode 1 done + an OpenAI org / project key |
| **3. On-prem production** | Run aide on a server inside your office / home / colo, reachable from internal users via a real domain | hours | Mode 2 done + reverse proxy + DNS + TLS + backup cron |

> **First time?** Always start at Mode 1. The whole stack runs on
> docker-compose; there's nothing to install beyond Docker itself.
> Once the UI loads and you've signed in once, escalate to Mode 2 to
> verify the OpenAI integration before committing to a cloud bill.

---

## Mode 1 — Pure local evaluation (5 minutes)

### Prerequisites

- **Docker Desktop 27+** (or Colima / Podman / Docker Engine on Linux)
- `git`, `openssl`, `curl`
- An OAuth app from **either** Google or GitHub (you only need one to
  sign in):
  - Google: <https://console.cloud.google.com/apis/credentials> → New
    OAuth 2.0 Client ID → set redirect to `http://localhost:3000/api/auth/callback/google`
  - GitHub: <https://github.com/settings/developers> → New OAuth App →
    set callback to `http://localhost:3000/api/auth/callback/github`

Both providers explicitly allow `http://localhost` for development —
no tunneling required.

### 1. Clone + configure

```bash
git clone https://github.com/hanfour/aide.git
cd aide/docker
cp .env.example .env
```

Edit `docker/.env` — fill in the values below; everything else use the
defaults from `.env.example`.

```bash
VERSION=latest                                   # or a specific release tag
DB_PASSWORD=local-dev-password                   # arbitrary; only used inside docker
AUTH_SECRET=$(openssl rand -base64 48)           # paste the openssl output
NEXTAUTH_URL=http://localhost:3000

# OAuth — fill in whichever provider's app you registered (or both)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

BOOTSTRAP_SUPER_ADMIN_EMAIL=you@example.com      # this email becomes super_admin on first sign-in
BOOTSTRAP_DEFAULT_ORG_SLUG=local
BOOTSTRAP_DEFAULT_ORG_NAME=Local Dev

# Gateway profile — required to start /v1/* surface
GATEWAY_BASE_URL=http://localhost:3002
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)  # paste output
API_KEY_HASH_PEPPER=$(openssl rand -hex 32)        # paste output
```

> The `$(openssl ...)` substitutions only work if you let your shell
> evaluate them — type them in the file as literal command output, not
> as `$(...)`. Either run `openssl rand -base64 48` in a terminal and
> paste the result, or use shell-eval'd `.env` (most editors don't).

### 2. Bring the stack up

```bash
docker compose up -d postgres redis migrate     # one-shot schema migration
docker compose --profile gateway up -d          # web + api + gateway
```

Watch first-boot logs (Ctrl+C exits the follow; services keep running):

```bash
docker compose --profile gateway logs -f
```

You should see:
- `migrate` finishes with "Migrations complete."
- `api` and `gateway` log "listening on 0.0.0.0:300X"
- `web` logs "ready in XXXms" and "Local: http://localhost:3000"

### 3. Verify

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # → 307 (redirects to /sign-in)
curl -fsS http://localhost:3002/health                              # → {"status":"ok"}
```

The web tier doesn't expose a JSON health endpoint — `docker compose ps`
showing `web` as `(healthy)` is enough; the 307 above just confirms Next.js
is serving traffic and the auth middleware is wiring redirects correctly.

Open <http://localhost:3000> in your browser → sign in with the email
you set as `BOOTSTRAP_SUPER_ADMIN_EMAIL` → you should land in
`/dashboard/organizations/<your-org>/`.

If sign-in fails with "OAuth callback error", the redirect URL you
registered with Google/GitHub doesn't match `NEXTAUTH_URL` exactly —
re-check the URLs and try again.

### 4. Tear down (when you're done)

```bash
docker compose --profile gateway down            # stop containers, keep data
docker compose --profile gateway down -v         # also wipe pg_data + redis_data
```

---

## Mode 2 — Add a real OpenAI key

Build on Mode 1. The stack is already up.

> **Want to use your Claude.ai (Pro / Max / Team) subscription instead
> of paying per-token for an OpenAI key?** See
> [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) for the Anthropic OAuth path —
> extracts the bundle from Claude Code's keychain, onboards via the same
> admin UI form, and walks the cross-device setup so other laptops /
> phones can route through your subscription quota.

### 1. Provision an OpenAI project key

Follow the full walkthrough in
[`admin/openai-account-setup.md`](./admin/openai-account-setup.md).
Quick version:

1. <https://platform.openai.com/> → create an org if you don't have one
2. Set a monthly **spend cap** at the org level (start small — e.g. $20)
3. Create a Project (e.g. `aide-local-eval`) with its own spend cap
4. From the Project's API keys page → **+ Create new secret key** →
   service-account-owned if available, scoped to inference only
5. Copy the `sk-proj-...` value (only shown once)

### 2. Onboard via the admin UI

In the local dashboard:

1. `/dashboard/organizations/<org>/accounts` → **New account**
2. Pick **OpenAI** + **API key**
3. Paste the `sk-proj-...` value
4. Scope: Organization-wide
5. Save

### 3. (Optional) Build a pool

If you have multiple project keys for different budgets:

1. `/dashboard/organizations/<org>/account-groups` → **New group**
2. Name: `openai-default`, Platform: OpenAI
3. Open the group → add each account with priority (lowest = preferred)

### 4. Issue a client API key

1. `/dashboard/profile` → **Generate new API key**
2. **Copy the `ak_...` value** — the gateway hashes it on save and
   you can never recover the plaintext

### 5. Smoke-test the full request path

```bash
curl -fsS http://localhost:3002/v1/chat/completions \
  -H "Authorization: Bearer ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "ping"}],
    "max_tokens": 16
  }' \
  -i
```

Expect a 200 with response headers including:

- `x-ratelimit-limit: 600` — per-apiKey RPM cap (default)
- `x-ratelimit-remaining: 599` — count down on each subsequent call
- `x-cache: miss` — only if you set `GATEWAY_CACHE_TTL_SEC > 0` first

If you get `503 no_upstream_available`, the OpenAI account isn't
active yet — go back to step 2 and confirm the saved row shows
`status='active'`.

### 6. (Optional) Try the cache

```bash
echo "GATEWAY_CACHE_TTL_SEC=300" >> .env
docker compose --profile gateway up -d gateway
```

Run the same curl twice in a row. The first call returns
`x-cache: miss`; the second returns `x-cache: hit` and arrives much
faster.

---

## Mode 3 — On-prem production

When you want aide running on a server inside your network for
internal users (not your laptop). Build on Mode 2 first.

### Required infrastructure

| Component | What you need |
|---|---|
| **Linux server** | 4 GB+ RAM, 20 GB+ disk, Docker installed. NAS / mini-PC / VM all fine |
| **Internal DNS** | Two hostnames resolving to the server's IP — e.g. `aide.internal.example.com` (admin UI) and `gateway.internal.example.com` (customer SDKs) |
| **TLS certificates** | Let's Encrypt (if server can reach the internet for ACME), internal CA, or self-signed |
| **Reverse proxy** | Caddy or nginx in front of docker-compose. Sample configs in [`../deploy/proxy/`](../deploy/proxy/) |
| **Backup target** | Off-server disk or NAS share for nightly `pg_dumpall` snapshots |
| **systemd unit** | So the stack auto-restarts after reboot |

### Setup walkthrough

#### 1. SSH into the server, install Docker + clone

```bash
# Debian/Ubuntu
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
git clone https://github.com/hanfour/aide.git /opt/aide
cd /opt/aide/docker
```

#### 2. Configure `.env` for the on-prem hostnames

Same as Mode 1 + 2, but with internal hostnames:

```bash
NEXTAUTH_URL=https://aide.internal.example.com
GATEWAY_BASE_URL=https://gateway.internal.example.com
```

OAuth providers need these new redirect URIs registered too —
update Google/GitHub OAuth apps before first sign-in or you'll get
the callback error.

#### 3. Reverse proxy + TLS

Pick one of the [`deploy/proxy/`](../deploy/proxy/) configs:

- **Caddy** (recommended for new setups, auto Let's Encrypt):
  ```bash
  apt install caddy
  cp /opt/aide/deploy/proxy/Caddyfile.example /etc/caddy/Caddyfile
  # Edit hostnames in /etc/caddy/Caddyfile to match your DNS
  systemctl reload caddy
  ```
- **nginx** (existing nginx infra):
  ```bash
  certbot certonly --standalone -d aide.internal.example.com -d gateway.internal.example.com
  cp /opt/aide/deploy/proxy/nginx.example.conf /etc/nginx/sites-available/aide
  # Edit hostnames + cert paths
  ln -s /etc/nginx/sites-available/aide /etc/nginx/sites-enabled/aide
  nginx -t && systemctl reload nginx
  ```

For internal-only deployments without internet access, swap Caddy/Let's Encrypt
for an internal CA — the configs in `deploy/proxy/` document the cert paths
they expect.

> **Trust-host posture for on-prem.** The `AUTH_TRUST_HOST` env defaults to
> `true` (set in compose) so Auth.js v5 accepts requests on whatever host
> your reverse proxy serves. That's correct when the proxy is yours
> (Caddy / nginx in `deploy/proxy/`) and `NEXTAUTH_URL` is the canonical
> external origin. If you ever sit behind a reverse proxy you don't control
> (e.g. a shared corporate edge that may forward arbitrary `Host` headers),
> set `AUTH_TRUST_HOST=false` in `.env` and rely on `NEXTAUTH_URL` alone —
> Auth.js will then reject requests on any other host.

#### 4. Bring the stack up

Same as Mode 1:

```bash
docker compose up -d postgres redis migrate
docker compose --profile gateway up -d
```

#### 5. Daily backup cron

Drop into root's crontab (`sudo crontab -e`):

```cron
0 3 * * * cd /opt/aide/docker && docker compose exec -T postgres pg_dumpall -U aide | gzip -9 > /backups/aide-$(date -u +\%F).sql.gz && find /backups -name 'aide-*.sql.gz' -mtime +14 -delete
```

Full procedure (including restore) in
[`runbooks/backup-and-restore.md`](./runbooks/backup-and-restore.md).

#### 6. Auto-start on reboot

Create `/etc/systemd/system/aide.service`:

```ini
[Unit]
Description=aide platform stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/aide/docker
ExecStart=/usr/bin/docker compose --profile gateway up -d
ExecStop=/usr/bin/docker compose --profile gateway down

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now aide
```

#### 7. Monitoring (optional but recommended)

Wire up Prometheus + alerts per [`monitoring/README.md`](../monitoring/README.md).
Even a single Prometheus scraping `gateway:3002/metrics` + the
shipped `alerts.yml` gives you incident-grade visibility.

---

## Troubleshooting

### "container 'migrate' exited with code 1"

Schema migration failed. Check `docker compose logs migrate` for the
actual error — usually a `DATABASE_URL` typo, or postgres still
booting. Wait 10s and retry; if persistent, drop the volume and
start clean (`docker compose down -v` — destroys data).

### Web shows "OAuth callback error"

The redirect URL registered with Google/GitHub doesn't EXACTLY match
`NEXTAUTH_URL`. Check both:
- The OAuth app's redirect URIs (must include `/api/auth/callback/{provider}`)
- `NEXTAUTH_URL` in `.env` (no trailing slash, scheme matches)

### Gateway returns `503 no_upstream_available`

You haven't onboarded an OpenAI account yet (Mode 2 step 2), or the
account is `status='oauth_invalid' / 'revoked'`. Check via SQL:

```sh
docker compose exec postgres psql -U aide -d aide -c \
  "SELECT id, name, status, schedulable FROM upstream_accounts;"
```

### Gateway returns `429 rate_limited` on every call

`GATEWAY_APIKEY_RPM_LIMIT` is set very low (or 0 with old behaviour).
Default is 600. Check:

```sh
docker compose exec gateway sh -c 'echo $GATEWAY_APIKEY_RPM_LIMIT'
```

### Logs flooded with `rate_limit_check_failed`

Redis is unhealthy and the rate limiter is failing open. Check:

```sh
docker compose exec redis redis-cli ping       # → PONG
docker compose --profile gateway logs redis | tail -20
```

Restart redis if needed (`docker compose restart redis`); the rate
limiter re-engages on next request.

### Browser sees "Mixed Content" errors after Mode 3 setup

`NEXTAUTH_URL` in `.env` is `http://...` but the reverse proxy
serves `https://`. Update to `https://...` and redeploy
(`docker compose --profile gateway up -d` after editing `.env`).

### More

- Full troubleshooting list: [`SELF_HOSTING.md`](./SELF_HOSTING.md) §8
- Operational alerts → runbook map: [`monitoring/prometheus/alerts.yml`](../monitoring/prometheus/alerts.yml)

---

## Where to next

- **Like what you see and want it on the internet?** Pick a cloud
  template in [`../deploy/`](../deploy/) — Render, Fly, Railway, or
  manual VPS via [`SELF_HOSTING.md`](./SELF_HOSTING.md).
- **Want to integrate with ChatGPT Team / Enterprise admin API?**
  Phase 2 of the migration plan, deferred until customer pull —
  open an issue / plan doc when it becomes a real ask.
- **Curious about the architecture?** [`GATEWAY.md`](./GATEWAY.md)
  explains the request pipeline, scheduler, and gateway/api split.
