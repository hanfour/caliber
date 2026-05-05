# Multi-device personal use — share your Claude Max via aide gateway

> **First time?** Read [`GETTING_STARTED.md`](./GETTING_STARTED.md)
> first — it's the linear walkthrough from "fresh git clone" to
> "Claude Code on a second device working". This doc is the deeper
> reference the tutorial cross-links to.

The killer use case for self-hosted aide isn't a multi-tenant SaaS — it's
**you, on multiple of your own devices, all proxying through one gateway
that's wired to your personal Claude Max / Pro subscription**. This guide
covers the workflow `LOCAL_DEPLOY.md` Mode 2 only hints at:

1. Onboard your **Claude Code OAuth bundle** (Anthropic, not OpenAI) so
   the gateway calls `api.anthropic.com` against your subscription quota
   rather than billing a project key.
2. Make the gateway **reachable from your other devices** without poking
   holes in your router or shipping plaintext over public Wi-Fi.
3. Point your **Claude Code / Cursor / Aider / any Anthropic-SDK client**
   at the gateway so day-to-day usage is transparent — no `curl`, no
   token juggling.

> **Prereq**: complete [`LOCAL_DEPLOY.md`](./LOCAL_DEPLOY.md) Mode 1
> (signed in, dashboard reachable). Mode 2 § for the OpenAI-API-key path
> is parallel to this one — pick whichever credential type you have.

---

## 1. Onboard the Anthropic OAuth credential

The admin UI form (`/dashboard/organizations/<id>/accounts/new`) accepts
Anthropic credentials in two flavours:

- **API key** (`sk-ant-...`) — pay-per-token from Anthropic Console
- **OAuth (JSON)** — refreshable token bundle from `claude auth login`,
  consumes your **Claude.ai subscription quota** (Pro / Max / Team)

The OAuth path is what makes "share my Claude Max with my own devices"
free of marginal cost. Anthropic considers this within-quota personal
use; the gateway just does the credential plumbing.

### 1.1 Extract the bundle from Claude Code's keychain

Claude Code stores the OAuth bundle in macOS Keychain under
`Claude Code-credentials`. Pull it and reshape into the schema the aide
form expects (snake_case keys, **ISO 8601** `expires_at`):

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
'
```

**Why the transform?**

| Keychain stores | aide form wants | Reason |
|---|---|---|
| `claudeAiOauth.accessToken` (camelCase, nested) | `access_token` (snake_case, flat) | Form schema |
| `expiresAt: 1777976972522` (unix-ms) | `"2026-05-05T10:29:32.522Z"` (ISO) | Gateway runtime requires ISO — see [#73](https://github.com/hanfour/aide/issues/73) |

Operator confusion on the `expires_at` format alone burns ~10 minutes
the first time; this section exists so the next person doesn't repeat
that. Until [#73](https://github.com/hanfour/aide/issues/73) lands, the
ISO transform above is mandatory.

### 1.2 Onboard via the admin UI

In the dashboard:

1. Go to **Accounts → New** for your org.
2. Pick **Anthropic** + **OAuth (JSON)**.
3. Paste the JSON output from §1.1 into the credentials box.
4. Submit. The row should appear with `Type: OAuth, Status: active`.

**Known UI gotcha**: the OAuth radio button can occasionally fail to
register a click (it visually flips but the form state stays on
`api_key`) — see [#72](https://github.com/hanfour/aide/issues/72). If
the saved row shows `Type: API key` after submit, delete it and re-create
making sure the OAuth radio is checked before clicking Submit.

### 1.3 Issue a client API key for yourself

Each device that wants to call the gateway needs its own `ak_...` key:

1. Go to **Profile → New key**.
2. Name it after the device that'll use it (e.g. `laptop-personal`,
   `work-mac`, `iphone-shortcuts`).
3. Copy the `ak_...` value — **it's only shown once**.
4. Repeat per device (don't share one key — see §4).

### 1.4 Smoke-test on the gateway host

Before wiring up other devices, confirm the local end works:

```bash
curl -sS http://localhost:3002/v1/messages \
  -H "Authorization: Bearer ak_..." \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  --data '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Expect a 200 with a real Anthropic response body. Anything else, fix
locally before going further — see §5 for common failure modes.

---

## 2. Reach the gateway from another device

The gateway listens on `0.0.0.0:3002` inside its container, port-mapped
to the same on the host. Anything that can establish a TCP connection
to the host's `:3002` and present a valid `ak_...` works.

The hard part is **how does another device's TCP packet reach your
gateway host's port 3002** — and that depends entirely on what network
sits between them.

### 2.1 Recommended: Tailscale (mesh VPN)

[Tailscale](https://tailscale.com/) builds a peer-to-peer encrypted
mesh between any devices logged into the same account. It bypasses
NAT, AP isolation, hotspot client isolation, and most consumer-router
firewalls — none of which you can fix from the client side.

**Setup**:

1. Install on the gateway host:
   ```bash
   brew install --cask tailscale     # macOS GUI + CLI
   # then launch Tailscale.app and login
   ```
2. Install on each other device, login the **same account**.
3. Get the host's MagicDNS hostname (more durable than the raw IP):
   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["Self"]["DNSName"].rstrip("."))'
   # e.g. h4.tail325fd5.ts.net
   ```
4. Smoke-test from another device:
   ```bash
   curl -sS http://h4.tail325fd5.ts.net:3002/health   # should print {"status":"ok"}
   ```

**Why this is the default recommendation**:

- Crosses **any** network boundary — home WiFi, hotspot, café Wi-Fi,
  cellular, even when both devices are on different ISPs
- **Encrypted** in transit (LAN's plaintext HTTP isn't)
- **Stable hostname** survives router / IP changes
- Works without any router admin access

### 2.2 Alternative: same-LAN direct (when it works)

If both devices are on the **same** trusted Wi-Fi (e.g. your own home
router with client-to-client allowed) and you don't want to install
Tailscale on the client:

```bash
# on the gateway host
ipconfig getifaddr en0     # macOS WiFi interface
# → e.g. 192.168.1.183

# on the other device
curl -sS http://192.168.1.183:3002/health
```

**This will fail** in any of the following common scenarios:

| Symptom | Cause | Fix |
|---|---|---|
| `No route to host` from client | Router has **AP isolation** / client isolation enabled (common on guest WiFi, mesh routers, ISP-supplied routers) | Disable in router admin if you can; otherwise use Tailscale |
| `Couldn't connect after 2ms` from client; host reaches itself fine | macOS Application Firewall blocking inbound to OrbStack/Docker even when whitelisted | Restart OrbStack after `socketfilterfw --add /Applications/OrbStack.app/Contents/MacOS/OrbStack`; or temporarily `--setglobalstate off` |
| Connection times out (no response) | iPhone Personal Hotspot **client isolation** (iOS 16+ default, no setting to disable) | Use Tailscale; or switch to a real router-backed Wi-Fi |
| Connection works from one direction only | Asymmetric router ACL — server can ping client but client can't reach server | Router-side configuration; usually faster to switch to Tailscale |

In short: same-LAN is a brittle path. Use it for quick tests when you
control the router; **default to Tailscale** for anything you actually
rely on.

### 2.3 Public URL: Cloudflare Tunnel / ngrok

For sharing with a device you can't put on your Tailnet (a friend's
machine, a CI runner, a webhook source):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3002
# emits an https://xxx.trycloudflare.com URL with TLS
```

**Caveat**: that URL is publicly reachable. Anyone holding a valid
`ak_...` can hit your subscription quota. Treat it like a public API
endpoint — short TTL keys, monitor usage, revoke quickly if the key
leaks.

### 2.4 Real on-prem: TLS + reverse proxy + DNS

For a proper internal-network deployment with a domain name, see
[`LOCAL_DEPLOY.md`](./LOCAL_DEPLOY.md#mode-3--on-prem-production)
Mode 3 — Caddy with auto Let's Encrypt is the lowest-friction path.

---

## 3. Wire your client tools

Every Anthropic client supports overriding the API base URL. Once you
do, the client transparently uses your gateway → your subscription —
without you ever typing `curl`.

### 3.1 Claude Code CLI (most common)

Claude Code reads two env vars:

- `ANTHROPIC_BASE_URL` — overrides `https://api.anthropic.com`
- `ANTHROPIC_AUTH_TOKEN` — overrides the keychain credentials from
  `claude auth login`

The cleanest setup is **shell aliases**, so you can pick between your
local Claude Code account and the gateway per-command:

```bash
# add to ~/.zshrc on the client device
export AIDE_GATEWAY_URL="http://h4.tail325fd5.ts.net:3002"   # your Tailscale URL
export AIDE_GATEWAY_KEY="ak_..."                             # this device's ak_ key

alias claude-aide='ANTHROPIC_BASE_URL=$AIDE_GATEWAY_URL ANTHROPIC_AUTH_TOKEN=$AIDE_GATEWAY_KEY claude'
alias aide-ping='curl -sS -o /dev/null -w "%{http_code}\n" $AIDE_GATEWAY_URL/health'
```

After `source ~/.zshrc`:

| Command | Does what |
|---|---|
| `claude` | Uses *this* device's keychain Claude Code account, hits `api.anthropic.com` directly |
| `claude-aide` | Routes through your gateway, consumes the gateway-host's subscription quota |
| `aide-ping` | Prints `200` if Tailscale is up and the gateway is reachable |

Both paths coexist — no `unset` required to switch.

> **Don't write `export ANTHROPIC_BASE_URL` directly into `.zshrc`** —
> that overrides Claude Code globally, including any `claude auth login`
> you do later for a separate account on the same machine. The alias
> form is reversible per-command.

### 3.2 Cursor

`Settings → Models → Override OpenAI Base URL`. The gateway also speaks
the OpenAI Chat Completions protocol on `/v1/chat/completions`, so the
override URL is `http://h4.tail325fd5.ts.net:3002/v1` and the API key is
your `ak_...`.

### 3.3 Aider / Continue.dev / opencode / others

Each of these has its own config file or settings UI. Look for:

- **API base URL** — set to your gateway's `http://...:3002` (or
  `http://...:3002/v1` for OpenAI-compat clients)
- **API key** — set to the per-device `ak_...`

### 3.4 Custom code (Python / TypeScript SDKs)

```python
from anthropic import Anthropic
client = Anthropic(
    base_url="http://h4.tail325fd5.ts.net:3002",
    api_key="ak_...",
)
```

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({
  baseURL: "http://h4.tail325fd5.ts.net:3002",
  apiKey: "ak_...",
});
```

Same pattern for `openai` SDK against the OpenAI-compat path with
`baseURL: ".../v1"`.

---

## 4. Multi-device hygiene

- **One `ak_...` per device.** Generate a new one in **Profile → New key**
  for each laptop / phone / scripting environment. If a device is lost
  or sold, revoke just that key — others keep working. Sharing one key
  across devices forces you to rotate everywhere when one leaks.
- **Name the key after the device.** `laptop-personal`, `work-mac`,
  `iphone-shortcuts`, `ci-runner`. The dashboard's API-keys list will
  thank you in 6 months.
- **Mac sleep = gateway down.** If you want availability while the
  host's lid is closed, either disable sleep for AC-power state in
  *System Settings → Lock Screen*, or run `caffeinate -d -i &` while
  sharing.
- **Refresh tokens have an expiry too.** OAuth `refresh_token` is
  long-lived but not infinite — if `claude auth login` ever invalidates
  it on the host's side (re-login, token rotation, account change),
  re-onboard via §1.1–1.2 with a fresh keychain extract.

---

## 5. Known limitations

These are issues we hit walking through this workflow against
v0.4.2 — fix candidates filed but not yet shipped:

| Issue | Symptom | Workaround |
|---|---|---|
| [#70](https://github.com/hanfour/aide/issues/70) | `Invalid uuid` on **Accounts → New** submit | Navigate to `/dashboard/organizations/<UUID>/accounts/new` (UUID, not slug) — pull the UUID from `SELECT id FROM organizations WHERE slug='<your-slug>'` |
| [#71](https://github.com/hanfour/aide/issues/71) | `NOT_FOUND` on accounts CRUD when running `--profile gateway` | Add `ENABLE_GATEWAY: "true"` + the four gateway env vars to the api service in `docker-compose.yml` until the upstream fix lands |
| [#72](https://github.com/hanfour/aide/issues/72) | Account saved with `Type: API key` despite picking OAuth | Delete and recreate; re-verify OAuth radio is selected immediately before clicking Submit |
| [#73](https://github.com/hanfour/aide/issues/73) | Gateway `503 all_upstreams_failed` after creating an OAuth account | The `expires_at` field must be ISO 8601, not a unix timestamp — use the transform in §1.1 |

If any new pitfall surfaces that isn't covered above, file an issue
referencing this doc so the next operator's path is shorter.
