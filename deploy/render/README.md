# Deploy aide to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hanfour/aide)

Render Blueprint that provisions:

- `aide-postgres` — managed Postgres 16 (`starter` plan, upgrade for prod)
- `aide-web` — Next.js admin UI (public web service)
- `aide-api` — Fastify + tRPC admin plane (private service)
- `aide-gateway` — customer-facing `/v1/*` proxy (public web service)

**External Redis required** — Render does not ship a native managed
Redis. Provision an Upstash instance (free tier) and paste the URL
during setup. See §1.

## What you need before clicking Deploy

| Item | How to get it |
|---|---|
| Render account | <https://render.com> |
| Upstash Redis instance | <https://console.upstash.com/redis/create> — free tier is fine for evaluation; production should pick a paid plan with persistence |
| OAuth credentials (Google + GitHub) | Same as `docs/SELF_HOSTING.md` §1 |
| Domain name(s) | One for the web (admin UI), one for the gateway. Render gives you `*.onrender.com` defaults if you don't have your own |
| Three secrets | `openssl rand -base64 48` (AUTH_SECRET), `openssl rand -hex 32` × 2 (CREDENTIAL_ENCRYPTION_KEY, API_KEY_HASH_PEPPER) |
| OpenAI org + project key | See `docs/admin/openai-account-setup.md` |

## 1. Provision Upstash Redis (5 min)

1. Sign in at <https://console.upstash.com/>.
2. Create database → pick a region close to your Render region (us-east is a
   safe default).
3. After creation, copy the **Redis URL** that starts with
   `redis://default:<password>@...:<port>`.
4. Hold onto this URL — you'll paste it into both `aide-api` and
   `aide-gateway` during the Render setup.

## 2. Click Deploy to Render

The button at the top of this README opens Render with the blueprint
pre-loaded. You'll be prompted to:

1. Pick a region (US East / US West / EU / Singapore — match your
   Upstash region for low latency).
2. Fill in the **service variables** (the ones marked `sync: false` in
   the blueprint):
   - `AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER`
     — paste the `openssl` outputs from the prerequisites table.
   - `NEXTAUTH_URL` — leave blank for now; Render assigns the host
     after first deploy. You'll come back and set it in §4.
   - `GATEWAY_BASE_URL` — same; set in §4.
   - `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` —
     OAuth provider creds. The redirect URLs to register are
     `https://<your-render-web-host>/api/auth/callback/{google,github}`.
   - `BOOTSTRAP_SUPER_ADMIN_EMAIL` — the email that becomes
     super_admin on first sign-in.
   - `REDIS_URL` (on both `aide-api` and `aide-gateway`) — paste the
     Upstash URL from §1.
3. Click "Apply" and wait ~5-10 min for the initial build.

## 3. Run schema migrations (one-time)

Render Blueprints don't ship a `migrate` job equivalent today. Run it
manually after first deploy:

```sh
# From the Render dashboard → aide-api → Shell:
node dist/migrate.js
```

Or if you prefer, configure a `preDeploy` hook on the `aide-api`
service via the dashboard — it'll run before each subsequent deploy.

## 4. Wire up your domain

After first deploy, Render assigns hostnames like:

- `aide-web-xyzw.onrender.com`
- `aide-gateway-xyzw.onrender.com`

You can either use these directly or attach your own domains.

Then update the env vars (Render dashboard → service → Environment):

- `aide-web` & `aide-api` & `aide-gateway`: set `NEXTAUTH_URL` to the
  web hostname (`https://aide-web-xyzw.onrender.com` or your custom
  domain).
- `aide-gateway`: set `GATEWAY_BASE_URL` to the gateway hostname.
- Re-register the OAuth redirect URIs with Google / GitHub under the
  new hostnames if they changed.

A redeploy is required for env-var changes to take effect.

## 5. First admin walkthrough

Same as the self-hosting guide:

1. Visit your web hostname → sign in via Google or GitHub with the
   `BOOTSTRAP_SUPER_ADMIN_EMAIL`.
2. Default org auto-created. Go to
   `/dashboard/organizations/<org>/accounts` → New account → OpenAI /
   API key / paste `sk-proj-...`.
3. (Optional) Create an account group at
   `/dashboard/organizations/<org>/account-groups` to pool multiple
   keys.
4. `/dashboard/profile` → Generate new API key → copy the `ak_...`
   value.
5. Smoke-test:
   ```sh
   curl https://<your-gateway-host>/v1/chat/completions \
     -H "Authorization: Bearer ak_..." \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
   ```
   Look for `x-ratelimit-limit: 600` and (when cache is on) `x-cache`
   headers in the response.

## Cost ballpark (US-East, 2026)

| Service | Plan | $/month |
|---|---|---|
| `aide-postgres` (starter) | Render | ~$7 |
| `aide-web` (starter) | Render | ~$7 |
| `aide-api` (starter, private) | Render | ~$7 |
| `aide-gateway` (starter) | Render | ~$7 |
| Upstash Redis (free tier) | external | $0 |
| **Total** | | **~$28/month** |

Plus your OpenAI / Anthropic API spend, which scales with usage.

For production, upgrade `aide-postgres` to `standard` (1 GB RAM, $20/mo)
and the web/gateway services to higher tiers based on RPS.

## Troubleshooting

### "AUTH_SECRET is required" on web boot
The blueprint marked `AUTH_SECRET: sync: false` — Render shows it
empty until you paste the value. Open the service's Environment tab
and fill it in, then redeploy.

### Web shows OAuth callback error
The OAuth redirect URL you registered with Google / GitHub doesn't
match `NEXTAUTH_URL`. Re-register both providers with the actual
Render-assigned (or custom) host.

### Gateway 503 with `no_upstream_available`
You haven't onboarded an OpenAI account yet. Go through §5 step 2.

### Other issues
See `docs/SELF_HOSTING.md` §8 (Troubleshooting) — the symptoms are
the same as Docker self-hosting.

## Updating

1. The blueprint pins `:latest` images. To pin to a release tag,
   edit `image.url` in `render.yaml` (your fork) and push — Render
   redeploys.
2. Run migrations as in §3 if the release notes say so.
