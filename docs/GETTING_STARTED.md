# Getting started — your personal AI gateway in 30 minutes

> **The goal**: by the end of this doc, your **Claude.ai Pro / Max
> subscription** is reachable from any of your devices via a self-hosted
> gateway running on your Mac. Claude Code on those devices uses your
> subscription transparently — no per-token API billing, no copy-pasting
> tokens, no `curl`.

## What you'll have when done

```
   📱 iPhone        💻 Other Mac        🖥 Work laptop
        \              |              /
         \             |             /
          \--- Tailscale mesh VPN ---/
                       |
                       v
              [Your Mac] aide gateway
                       |
                       v
                api.anthropic.com
              (your Claude Max quota)
```

Each device runs `claude-aide` (or any Anthropic-SDK client pointed at
the gateway) → gateway proxies to Anthropic using your OAuth bundle →
your Claude Max subscription handles the inference.

## Prerequisites

| Need | Why | How |
|---|---|---|
| **macOS** with [Docker Desktop](https://www.docker.com/products/docker-desktop/) **or** [OrbStack](https://orbstack.dev/) installed and running | The aide stack runs in containers | OrbStack is recommended on Apple Silicon — lighter, faster |
| **GitHub account** | To sign in to the aide admin dashboard | Free, you probably have one |
| **Claude.ai Pro or Max subscription** | The upstream that gateway proxies to. Pro = $20/mo, Max = $200/mo. Both work. | <https://claude.ai/upgrade> |
| **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) installed and logged in** | We extract the OAuth bundle from its keychain entry | `npm install -g @anthropic-ai/claude-code` then `claude auth login` |
| **`git`, `curl`, `python3`** in PATH | Standard tools for this walkthrough | macOS has all three by default |
| **~30 minutes** | Roughly: 10 setup, 10 onboard, 10 multi-device | One-time investment |

> **What you do NOT need**: an OpenAI API key (we're going the
> Anthropic path), a domain name, a public server, a static IP, or
> router admin access (Tailscale handles network plumbing).

---

## Part 1 — Get the stack running (10 min)

### 1.1 Clone the repo

```bash
git clone https://github.com/hanfour/aide.git
cd aide
```

### 1.2 Register a GitHub OAuth app for sign-in

The aide admin dashboard authenticates users via OAuth. We use GitHub
for simplicity — Google works too, both are optional individually but
**at least one** must be configured.

1. Go to <https://github.com/settings/developers> → **OAuth Apps** →
   **New OAuth App**
2. Fill in:
   - **Application name**: `aide local` (or anything)
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github` *(must be exact)*
3. Click **Register application**
4. On the resulting page:
   - Copy the **Client ID** — keep handy for §1.4
   - Click **Generate a new client secret**, copy it too — keep handy

Both values can be regenerated later if leaked.

### 1.3 Generate three secrets

Open a terminal and run:

```bash
echo "AUTH_SECRET=$(openssl rand -base64 48)"
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "API_KEY_HASH_PEPPER=$(openssl rand -hex 32)"
```

You'll get three lines like:

```
AUTH_SECRET=xxxxxxxx...
CREDENTIAL_ENCRYPTION_KEY=64-hex-chars
API_KEY_HASH_PEPPER=64-hex-chars
```

Keep them. The first signs cookies. The second encrypts upstream
credentials at rest (OAuth tokens, API keys). The third pepper-hashes
client API keys so a database leak can't be replayed.

### 1.4 Fill in `.env`

```bash
cd docker
cp .env.example .env
```

Open `docker/.env` in any editor. **Set these 9 values** (everything
else can stay commented or default):

```bash
VERSION=v0.4.2
DB_PASSWORD=local-dev-password                    # any throwaway string

AUTH_SECRET=<paste from §1.3>
NEXTAUTH_URL=http://localhost:3000

# OAuth — at least ONE provider. We're using GitHub:
GITHUB_CLIENT_ID=<paste from §1.2>
GITHUB_CLIENT_SECRET=<paste from §1.2>
# Leave Google blank if you only registered GitHub.

BOOTSTRAP_SUPER_ADMIN_EMAIL=<your-github-email>   # this becomes super_admin on first sign-in
BOOTSTRAP_DEFAULT_ORG_SLUG=local
BOOTSTRAP_DEFAULT_ORG_NAME=Local Dev

GATEWAY_BASE_URL=http://localhost:3002
CREDENTIAL_ENCRYPTION_KEY=<paste from §1.3>
API_KEY_HASH_PEPPER=<paste from §1.3>
```

The `BOOTSTRAP_SUPER_ADMIN_EMAIL` value matters — it must match the
email on your GitHub account so the first sign-in auto-bootstraps you
as `super_admin`. Otherwise you'll get an "access denied" page.

### 1.5 Apply the issue-#71 workaround (necessary for admin onboarding)

Until [#71](https://github.com/hanfour/aide/issues/71) is fixed
upstream, the api service needs `ENABLE_GATEWAY=true` plus four
gateway-related env vars whenever you intend to add upstream accounts
via the admin UI. Edit `docker/docker-compose.yml`, find the `api:`
block, and change:

```yaml
  api:
    ...
    environment:
      <<: *app-env
      PORT: 3001
```

…to:

```yaml
  api:
    ...
    environment:
      <<: *app-env
      ENABLE_GATEWAY: "true"
      GATEWAY_BASE_URL: ${GATEWAY_BASE_URL:-}
      REDIS_URL: redis://redis:6379
      CREDENTIAL_ENCRYPTION_KEY: ${CREDENTIAL_ENCRYPTION_KEY:-}
      API_KEY_HASH_PEPPER: ${API_KEY_HASH_PEPPER:-}
      PORT: 3001
```

Without this, **Accounts → New** in the admin UI returns `NOT_FOUND`.

### 1.6 Bring the stack up

```bash
docker compose up -d postgres redis migrate    # one-shot schema init
docker compose --profile gateway up -d         # api + web + gateway
sleep 10
docker compose ps
```

Expected: 5 containers, all `(healthy)`:

```
NAME                STATUS                   PORTS
docker-api-1        Up X seconds (healthy)   3001/tcp
docker-gateway-1    Up X seconds (healthy)   0.0.0.0:3002->3002/tcp
docker-postgres-1   Up X seconds (healthy)
docker-redis-1      Up X seconds (healthy)
docker-web-1        Up X seconds (healthy)   0.0.0.0:3000->3000/tcp
```

If any are not healthy, see [Troubleshooting](#troubleshooting) below.

### 1.7 Sign in to the dashboard

Open <http://localhost:3000> in your browser. You'll be redirected to
`/sign-in`. Click **Sign in with GitHub** → authorize the OAuth app →
land on `/dashboard`.

The top-left should show **Local Dev** (the org we bootstrapped via
`BOOTSTRAP_DEFAULT_ORG_SLUG`), and the dashboard should list your role
as `super_admin @ global`. **If you see "No workspace" or empty stats**,
your sign-in email didn't match `BOOTSTRAP_SUPER_ADMIN_EMAIL` exactly
— go back to §1.4 and fix.

✅ **End of Part 1**: stack running, dashboard reachable, you're admin.

---

## Part 2 — Onboard your Claude Max subscription (10 min)

### 2.1 Why OAuth instead of an API key

Anthropic offers two ways to authenticate:

| Approach | What you get | Cost model |
|---|---|---|
| **API key** (`sk-ant-...`) from <https://console.anthropic.com> | Direct API access | Pay-per-token (literally $$ per inference) |
| **OAuth bundle** (`access_token`/`refresh_token`/`expires_at`) from `claude auth login` | Same direct API access | Counts against your **Claude.ai subscription quota** (Pro / Max / Team) |

If you're already paying for Claude.ai Pro/Max, the OAuth path means
your gateway usage from any device just consumes the subscription
quota you're already paying for — **no extra billing**.

### 2.2 Extract the OAuth bundle from Claude Code's keychain

Claude Code stores its OAuth tokens in macOS Keychain under the entry
named `Claude Code-credentials`. Pull it and reshape into the JSON
schema the aide admin form expects:

```bash
security find-generic-password -s 'Claude Code-credentials' -w \
  | python3 -c '
import sys, json
from datetime import datetime, timezone
raw = json.load(sys.stdin)
oa = raw["claudeAiOauth"]
out = {
    "access_token": oa["accessToken"],
    "refresh_token": oa["refreshToken"],
    "expires_at": datetime.fromtimestamp(oa["expiresAt"]/1000, tz=timezone.utc)
                          .isoformat().replace("+00:00", "Z"),
}
print(json.dumps(out))
' | tee /tmp/aide-anthropic-oauth.json
```

You'll see something like:

```json
{"access_token": "sk-ant-oat01-...", "refresh_token": "sk-ant-ort01-...", "expires_at": "2026-05-05T10:29:32.522000Z"}
```

**Why the transform**: keychain stores camelCase keys nested under
`claudeAiOauth`, with `expiresAt` as a unix-millisecond integer. The
aide form needs flat snake_case + ISO 8601 expires_at. The Python
one-liner does both jobs. (See
[#73](https://github.com/hanfour/aide/issues/73) for why this is
necessary today.)

### 2.3 Find your org's UUID

The admin form passes `orgId` as a UUID, but dashboard URLs use the
slug (`local`). Today they don't auto-translate — see
[#70](https://github.com/hanfour/aide/issues/70). Pull the UUID
manually:

```bash
docker compose exec -T postgres \
  psql -U aide -d aide -tAc "SELECT id FROM organizations WHERE slug='local';"
```

You'll get something like `7549a089-b355-4f6d-b286-25154e02c856`. Keep
this UUID handy.

### 2.4 Onboard via the admin UI

1. Open
   `http://localhost:3000/dashboard/organizations/<UUID>/accounts/new`
   (with the UUID from §2.3 — the slug-URL form would fail with
   `Invalid uuid` per #70)
2. Fill the form:
   - **Name**: `Claude Max — host` (or anything memorable)
   - **Platform**: **Anthropic**
   - **Type**: ⚠️ **OAuth (JSON)** — see gotcha below
   - **Scope**: Organization
   - **Credentials**: paste the JSON from `/tmp/aide-anthropic-oauth.json`
3. Click **Create account**.

> **OAuth-radio gotcha** ([#72](https://github.com/hanfour/aide/issues/72)):
> the OAuth radio sometimes visually toggles but the form state stays on
> `api_key`, silently saving with the wrong type. After submit, look at
> the row's **Type** column — if it shows `API key` instead of `OAuth`,
> delete and recreate; verify the radio is checked just before clicking
> Submit. If you keep losing this fight, run this in the browser console
> while on the form to force-toggle:
> ```js
> document.querySelector('input[type=radio][name=type][value=oauth]').click()
> ```

You should see a toast `Account "Claude Max — host" created` and land
on the Accounts list with a row showing **Type: OAuth, Status: Active**.

### 2.5 Issue your first device API key

Each device that wants to use the gateway needs its own `ak_...` key.
Issue one for the Mac running the gateway itself first (we'll add more
for other devices later):

1. Go to <http://localhost:3000/dashboard/profile>
2. Click **New key**
3. Name: `host-mac` (or this device's name)
4. Click **Generate key**
5. **Copy the `ak_...` value immediately** — it's only shown once. The
   modal will close and you can never recover the plaintext.

Keep this key around for §2.6 and §3.

### 2.6 Smoke test from this Mac

```bash
AK=ak_...                                  # paste your key here
curl -sS http://localhost:3002/v1/messages \
  -H "Authorization: Bearer $AK" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  --data '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"reply: pong"}],"max_tokens":16}'
```

Expected: a JSON response with `"content":[{"type":"text","text":"pong"}]`,
`"model":"claude-haiku-4-5-20251001"`, and an `anthropic-organization-id`
header matching your Claude.ai org.

If you get `503 all_upstreams_failed`, the OAuth bundle's `expires_at`
format is wrong — check that the JSON in `/tmp/aide-anthropic-oauth.json`
has a string ISO date, not a number.

✅ **End of Part 2**: gateway proxies to Anthropic via your Claude Max
subscription. One device working.

---

## Part 3 — Use it from another device (10 min)

We use [Tailscale](https://tailscale.com/), a mesh VPN, to make the
host Mac reachable from any other device. It bypasses the dozen
different ways consumer routers / hotspots / firewalls block direct
LAN access.

### 3.1 Install Tailscale on both devices

**On the host Mac**:

```bash
brew install --cask tailscale
open -a Tailscale            # launch the GUI
# Click "Log in" → authenticate with Google/GitHub/Microsoft
```

**On the other device** (Mac, Linux, Windows, iPhone, Android — all
supported): install the Tailscale app and **log in with the same
account**. Devices on the same Tailscale account form a private mesh.

### 3.2 Get the host's MagicDNS hostname

The host Mac's Tailscale IP is something like `100.119.248.33`, but
Tailscale also assigns a stable DNS name. The latter is preferred —
it survives IP changes and is easier to remember.

On the host Mac:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)["Self"]
print(f"DNSName : {d[\"DNSName\"].rstrip(\".\")}")
print(f"IPv4    : {d[\"TailscaleIPs\"][0]}")
'
```

Output:

```
DNSName : <hostname>.<tailnet>.ts.net
IPv4    : 100.x.x.x
```

Either works. We'll use the DNSName. Keep handy.

### 3.3 Issue another `ak_...` key for the other device

(One key per device — see §4 for why.)

Back on the host's `<http://localhost:3000/dashboard/profile>`, click
**New key**, name it after the second device (e.g. `laptop-personal`),
copy the `ak_...` value.

### 3.4 Sanity test from the other device

On the other device, paste:

```bash
curl -sS http://<dns-from-§3.2>:3002/health
```

Expected: `{"status":"ok"}`. If you get connection refused or timeout,
see [Troubleshooting](#troubleshooting) — but it's almost always
"Tailscale not actually logged in on one side" or "the host Mac is
sleeping".

### 3.5 Set up the `claude-aide` alias

Append this to `~/.zshrc` on the **other device** (not the host):

```bash
cat >> ~/.zshrc <<'EOF'

# ── aide gateway via Tailscale ────────────────────────────────
export AIDE_GATEWAY_URL="http://<dns-from-§3.2>:3002"
export AIDE_GATEWAY_KEY="<ak_-from-§3.3>"

alias claude-aide='ANTHROPIC_BASE_URL=$AIDE_GATEWAY_URL ANTHROPIC_AUTH_TOKEN=$AIDE_GATEWAY_KEY claude'
alias aide-ping='curl -sS -o /dev/null -w "%{http_code}\n" $AIDE_GATEWAY_URL/health'
EOF

source ~/.zshrc
```

Now on that device:

| Command | Behaviour |
|---|---|
| `claude` | Uses **this device's own** `claude auth login` credentials, hits `api.anthropic.com` directly |
| `claude-aide` | Routes via your Tailscale → host Mac's gateway → host's Claude Max subscription |
| `aide-ping` | Prints `200` if the path is healthy, anything else if broken |

Both `claude` and `claude-aide` coexist — no `unset` required.

### 3.6 Test it

```bash
aide-ping              # → 200
claude-aide --print "say hi via aide"
```

Should respond like a normal Claude conversation. Token usage is
counted against the **host Mac's Claude Max quota**, not this
device's.

✅ **End of Part 3**: you can now use Claude Code from any device on
your Tailnet, all routing through your single subscription.

---

## Day-2 usage — coming back after a break

After the first-time setup, you don't have to redo any of the above.
Day-2 looks like:

```bash
# On the host Mac — bring stack back up (~30 sec)
cd /path/to/aide/docker
docker compose --profile gateway up -d
docker compose ps                          # all 5 should turn healthy

# On any device — verify
aide-ping                                  # → 200
claude-aide --print "test"                 # → real response
```

Done. The DB volume is preserved across `down` / `up`, so user, org,
OAuth account, and `ak_...` keys all stay intact.

To stop:

```bash
docker compose --profile gateway down      # stop, keep DB
# OR
docker compose --profile gateway down -v   # stop + WIPE DB (forces full re-onboard)
```

> **Mac sleep = gateway dies.** If you want the gateway available while
> the host's lid is closed, either disable sleep in *System Settings →
> Lock Screen*, or run `caffeinate -d -i &` in any terminal — both keep
> the host awake (at the cost of battery if not plugged in).

### Quality of life: lifecycle aliases

Typing the multi-step `cd … && docker compose …` chain every time gets
old. Drop these three helpers into the host Mac's `~/.zshrc` (or
`~/.bashrc`) so day-2 collapses to a single `aide-up`:

```bash
# ── aide gateway lifecycle ─────────────────────────────────────────
export AIDE_DIR="$HOME/path/to/aide/docker"     # ← edit to your checkout
export AIDE_PORT="3002"                         # ← match GATEWAY_PORT in .env

aide-up() {
  (cd "$AIDE_DIR" && docker compose --profile gateway up -d) || return 1
  sleep 6
  curl -sS -o /dev/null -w "gateway: HTTP %{http_code}\n" \
    "http://localhost:${AIDE_PORT}/health"
  pgrep -qf 'caffeinate -d -i' >/dev/null 2>&1 || (caffeinate -d -i &)
  echo "✅ aide up + caffeinate keeping mac awake"
}

aide-down() {
  # Kills ANY `caffeinate -d -i` — if you run caffeinate for another
  # purpose, narrow this filter or stop that process separately.
  pkill -f 'caffeinate -d -i' 2>/dev/null
  (cd "$AIDE_DIR" && docker compose --profile gateway down)
  echo "✅ aide down + caffeinate killed (mac can sleep again)"
}

aide-status() {
  (cd "$AIDE_DIR" && docker compose ps \
    --format 'table {{.Name}}\t{{.Status}}')
  echo
  curl -sS -o /dev/null -w "gateway: HTTP %{http_code}\n" \
    "http://localhost:${AIDE_PORT}/health" 2>&1
  pgrep -qf 'caffeinate -d -i' \
    && echo "caffeinate: running" \
    || echo "caffeinate: not running"
}
```

`source ~/.zshrc` once, then:

| Command | Behaviour |
|---|---|
| `aide-up` | Boots the stack, waits ~6s, prints gateway health, ensures `caffeinate` is running so other devices stay reachable |
| `aide-down` | Stops the stack (keeps DB volume) and kills `caffeinate` so the Mac can sleep |
| `aide-status` | Prints container state + gateway HTTP code + caffeinate status |

DB volume is preserved across `aide-down`/`aide-up` cycles, so user,
org, OAuth account, and `ak_…` keys all stay intact — no re-onboarding.

> **Auto-start on Mac login** is left as an exercise — launchd plists
> invoke binaries (not zsh functions), so you'd wrap `aide-up` in a
> standalone script and reference that script from the plist. Most
> operators find the explicit alias more intuitive anyway: you control
> when the stack (and its battery cost) is running.

---

## Troubleshooting

### Stack issues

| Symptom | Cause | Fix |
|---|---|---|
| `migrate` exits with code 1 | Postgres not yet healthy or stale volume | `docker compose down -v` (WIPES DB) and start over |
| `gateway` restarts in a loop | Missing or malformed env (e.g. typo in `CREDENTIAL_ENCRYPTION_KEY`) | `docker compose logs gateway` — error message names the bad var |
| `web` shows **OAuth callback error** after sign-in | GitHub OAuth app callback URL doesn't match `NEXTAUTH_URL` | Recheck §1.2 callback URL is `http://localhost:3000/api/auth/callback/github` exactly |
| Dashboard renders chrome but body is permanently `Loading…` | tRPC silently failing — usually the api isn't reachable | `docker compose logs api` for errors; verify §1.5 workaround applied |

### Onboarding issues

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid uuid` toast on **Accounts → New** | URL uses slug not UUID | Use the UUID from §2.3 in the URL |
| `NOT_FOUND` toast on Accounts CRUD | api missing `ENABLE_GATEWAY=true` | Apply the §1.5 workaround, recreate api: `docker compose up -d --force-recreate api` |
| Created account shows `Type: API key` despite picking OAuth | Issue [#72](https://github.com/hanfour/aide/issues/72) — radio click flake | Delete and recreate; force-toggle with the JS one-liner in §2.4's gotcha |

### Gateway request issues

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` | `ak_...` key wrong or revoked | Check **Profile** dashboard, issue a new key if needed |
| `503 all_upstreams_failed` + log `oauth payload missing expires_at ISO string` | OAuth account stored with unix-ms timestamp instead of ISO | Delete account, recreate using the §2.2 transform |
| `503 all_upstreams_failed` + log `refresh failed` or `403` | OAuth refresh_token expired (rare — usually weeks/months) | `claude logout && claude login` on host, redo §2.2-§2.4 |
| `503` with no obvious error | Anthropic upstream temporarily unavailable | Retry in a few minutes |
| `429 rate_limited` on every call | `GATEWAY_APIKEY_RPM_LIMIT` too low (default 600) | Either raise it via env, or slow down |

### Cross-device issues

| Symptom | Cause | Fix |
|---|---|---|
| `aide-ping` → `Couldn't connect after 2ms` | Host Mac sleeping, or `docker compose down`'d, or Tailscale logged out one side | Wake the Mac, `up -d`, or re-login Tailscale |
| `aide-ping` works but `claude-aide` errors | Old expired `ak_...` in alias, or alias not sourced | `echo $AIDE_GATEWAY_KEY` to verify; `source ~/.zshrc` if env empty |
| Direct LAN (`http://192.168.x.x:3002`) refused | Router has client isolation, or hotspot isolates clients (iOS), or macOS firewall + OrbStack interaction | Use Tailscale instead; LAN-direct in untrusted environments rarely works |

For deeper LAN troubleshooting, see
[`MULTI_DEVICE.md §2.2`](./MULTI_DEVICE.md#22-alternative-same-lan-direct-when-it-works).

---

## Advanced

### Multi-device hygiene

- **One `ak_...` per device.** Generate a new one in **Profile** for
  each laptop / phone / scripting environment. Naming convention helps:
  `laptop-personal`, `work-mac`, `iphone-shortcuts`, `ci-runner`.
- **Revoke quickly when devices change owners.** **Profile** → click
  the trash icon on a key → effective immediately. Other devices keep
  working.
- **Track usage per key.** The dashboard's usage page (`/dashboard/profile/usage`)
  breaks down requests by key, so you can see which device is busiest.

### Wire other client tools (not just Claude Code)

The gateway speaks the standard Anthropic Messages API on `/v1/messages`
and an OpenAI-compatible Chat Completions API on `/v1/chat/completions`.
Anything that can override the API base URL works:

| Tool | Where to set base URL | Path |
|---|---|---|
| **Cursor** | Settings → Models → Override OpenAI Base URL | `http://<dns>:3002/v1` (OpenAI-compat) |
| **Aider** | `--openai-api-base` flag or env | `http://<dns>:3002/v1` |
| **opencode** / **Continue.dev** | Their config file | `http://<dns>:3002` (Anthropic) or `/v1` (OpenAI) |
| **Anthropic Python SDK** | `Anthropic(base_url=..., api_key=...)` | `http://<dns>:3002` |
| **OpenAI Python SDK** | `OpenAI(base_url=..., api_key=...)` | `http://<dns>:3002/v1` |

API key in all cases is your `ak_...`.

See [`MULTI_DEVICE.md §3`](./MULTI_DEVICE.md#3-wire-your-client-tools)
for code snippets.

### When OAuth refresh_token finally expires

`access_token` lasts ~1 hour and the gateway auto-refreshes it using
the longer-lived `refresh_token`. The `refresh_token` itself can last
weeks to months — but eventually Anthropic invalidates it (account
re-login, security event, etc.).

Symptoms: gateway logs flood with `refresh failed: 401` or `403`. Fix:

```bash
# On the host Mac
claude logout
claude login                                                # opens browser, re-authenticates
# Re-run §2.2 to regenerate /tmp/aide-anthropic-oauth.json
# Delete the stale OAuth account in admin UI and re-add with the new JSON
```

### Production / on-prem (real domain + TLS)

For a deployment where the gateway sits on a real server inside an
office or colo, with HTTPS and a real hostname, see
[`LOCAL_DEPLOY.md` Mode 3](./LOCAL_DEPLOY.md#mode-3--on-prem-production).
Caddy with auto-Let's Encrypt is the lowest-friction path.

---

## Known limitations (as of v0.4.2)

These were surfaced during this guide's validation and have follow-up
fixes filed but not yet shipped:

| Issue | Impact | Workaround |
|---|---|---|
| [#70](https://github.com/hanfour/aide/issues/70) — slug→UUID mismatch | `Invalid uuid` on admin form submits | Use UUID URL (§2.3) |
| [#71](https://github.com/hanfour/aide/issues/71) — api ENABLE_GATEWAY missing | `NOT_FOUND` on accounts CRUD | compose env additions (§1.5) |
| [#72](https://github.com/hanfour/aide/issues/72) — OAuth radio click flake | Account silently saved as wrong type | Verify Type column; force JS click |
| [#73](https://github.com/hanfour/aide/issues/73) — `expires_at` ISO required | Gateway 503 if you paste unix-ms | Use the §2.2 Python transform |

When these land in v0.4.3+, the corresponding workarounds in this doc
become unnecessary. Until then, follow the workaround inline at each
step.

---

## Where to go from here

- **`docs/MULTI_DEVICE.md`** — deeper dives into network paths
  (Tailscale vs LAN), client wiring, multi-device hygiene
- **`docs/LOCAL_DEPLOY.md`** — Mode 3 on-prem deployment, Mode 2 with
  OpenAI key (alternative to Claude Max)
- **`docs/GATEWAY.md`** — full reference for every gateway env var
- **`docs/SELF_HOSTING.md`** — production self-hosting reference

If something in this guide didn't work and isn't covered above, file
an issue referencing the section number — the next operator's path
gets shorter.
